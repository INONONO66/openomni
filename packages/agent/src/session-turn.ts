import { Cause, Effect, Exit, Option, type Scope } from "effect";
import { z } from "zod";
import type { SessionHandleStore } from "@openomni/ledger";
import { canonicalDigest, type PlainValue, type SessionGeneration, type SessionTurn, type Inbox, type LedgerSession } from "@openomni/protocol";
import { createExecutor, type ExecutionResult } from "./executor";
import { CommitFailed, ForeignFailure, type ExecutionError, type SessionError } from "./errors";
import { hydrateSessionHistory } from "./session-lifecycle/history";
import { commitFoldBatch } from "./session-fold-commit";
import { sessionStopEvidence } from "./session-stop-evidence";
import type { SessionKernel } from "./cluster/kernel-registry";
import type { SessionPolicyRefusal, ResolvedSessionRuntime, SessionRunner, SessionRunnerResult, SessionActionCommitPort, SessionBoundaryResult } from "./session-contract";
import { turnCheckpointAction, deliveryActions, turnTerminalAction, policyRefusalResult, sessionRunnerResultValue, sessionRunnerResultFromValue, pendingBacklog, receivedMessages } from "./session-record";
import type { SessionControllerState } from "./session-controller-state";
import { GenerationOwnership, ObservationSink, type RunnerServices } from "./services";
import { parentReply } from "./session-parent-reply";
import { dispatchSessionOutbound, outboundOpen } from "./session-outbound";
import { observeDrained } from "./session-message-observation";

const ExternalOrigin = z.object({ kind: z.literal("external") });
const FullAccessOrigin = ExternalOrigin.extend({ inboundTreatment: z.literal("full_access") });

/**
 * Turn authority from the prompt's inbox origin. Internal senders (session
 * messages, fixtures) act; an external origin acts only when the perimeter
 * recorded `full_access` verbatim — a missing or unrecognised treatment on an
 * external origin fails closed to evidence-only.
 */
export function inboundAuthority(origin: PlainValue | undefined): "act" | "evidence_only" {
  if (!ExternalOrigin.safeParse(origin).success) return "act";
  return FullAccessOrigin.safeParse(origin).success ? "act" : "evidence_only";
}

interface TurnInput {
  readonly turnId: string;
  readonly resultId: string;
  readonly parentActionId: string;
  readonly boundaryActionId: string | null;
  readonly resumeCount: number;
  readonly generation: SessionGeneration.Snapshot;
  readonly resume: boolean;
}

export function createSessionTurn(
  kernel: SessionKernel,
  sessionId: string,
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  scope: Scope.Scope,
  ports: {
    readonly createExecutionLedger: (turnId?: string) => SessionActionCommitPort;
    readonly evaluatePromptPolicies: (items: readonly Inbox.Row[]) => Effect.Effect<SessionPolicyRefusal | undefined, ExecutionError, RunnerServices>;
    readonly consumePolicyBlockedInbox: (items: readonly Inbox.Row[]) => Effect.Effect<void, ExecutionError>;
    readonly hibernate: (current: LedgerSession.Row) => Effect.Effect<void, SessionError>;
  },
) {
  function runTurn(input: TurnInput): Effect.Effect<SessionRunnerResult, SessionError> {
    return Effect.scoped(Effect.gen(function* () {
      const captured = yield* runtime.generations.capture({ sessionId, generation: input.generation.generation });
      const ownership = { ...captured, retain() {
        const generation = captured.retain();
        const session = state.rawSlots.open();
        return () => { generation(); session(); };
      } };
      return yield* captured.provide(runCaptured(input).pipe(Effect.provideService(GenerationOwnership, ownership))).pipe(Effect.provide(runtime.services));
    }));
  }

  function runCaptured(input: TurnInput): Effect.Effect<SessionRunnerResult, SessionError, RunnerServices> {
    return Effect.gen(function* () {
      const services = yield* Effect.context<RunnerServices>();
      const row = kernel.row(sessionId);
      const controller = new AbortController();
      state.controller = controller;
      let parentActionId = input.parentActionId;
      let boundaryActionId = input.boundaryActionId;
      const ledger = ports.createExecutionLedger(input.turnId);
      const retainEffect = (raw: Promise<void>) => {
        const settle = state.rawSlots.open();
        void raw.then(settle);
      };
      const execution = yield* createExecutor({
        retryAlarm: runtime.retryAlarm, signal: controller.signal, retainEffect,
        closeGraceMs: runtime.closeGraceMs, ledger,
        identity: { sessionId, role: row.role, parentActionId: input.turnId },
      });
      const boundary = (kind: SessionTurn.Boundary): Effect.Effect<SessionBoundaryResult, ExecutionError> => Effect.gen(function* () {
        if (controller.signal.aborted) return { messages: [], interrupted: true };
        const drained = yield* drainBoundary(input, kind, parentActionId);
        parentActionId = drained.parentActionId;
        boundaryActionId = drained.boundaryActionId;
        if (drained.interrupted) controller.abort();
        return { messages: drained.messages, interrupted: drained.interrupted };
      }).pipe(Effect.provide(services));
      let runnerResult: SessionRunnerResult = policyRefusalResult("invalid_output");
      const body = Effect.gen(function* () {
        if (controller.signal.aborted) return yield* Effect.interrupt;
        const hydrated = hydrateSessionHistory(kernel, sessionId);
        const promptId = hydrated.messages.filter((message) => message.role === "user").at(-1)?.id;
        const origin = receivedMessages(kernel, sessionId).rows.find((item) => item.id === promptId)?.origin;
        runnerResult = yield* runner({
          authority: inboundAuthority(origin?.value),
          sessionId, kernel, role: row.role, turnId: input.turnId, actionId: input.parentActionId,
          ledger, retainEffect, bindApprovals: (approvals) => { state.activeApprovals = approvals; },
          stopEvidence: sessionStopEvidence(kernel, sessionId, input.turnId, () => state.activeApprovals, runtime.openIntent),
          resultId: input.resultId, parentActionId, boundaryActionId,
          messages: hydrated.messages,
          history: hydrated.history,
          tools: input.generation.tools, toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          system: input.generation.systemValue, systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration,
          resumeCount: input.resumeCount, signal: controller.signal, boundary,
        });
        return sessionRunnerResultValue(runnerResult);
      });
      const work = execution.runExisting({
        kind: "turn", op: "session",
        intent: {
          turnId: input.turnId, resultId: input.resultId, resumeCount: input.resumeCount, resume: input.resume,
          toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration,
        }, effect: { terminal: "sealed" },
      }, () => withSignal(body, controller.signal));
      const exit = yield* Effect.exit(work);
      const result = resultOf(exit, runnerResult);
      if (state.controller === controller) state.controller = undefined;
      // A raw slot, unlike its fiber, can outlive interruption. Its generation
      // remains owned by the app Scope until actual raw settlement.
      const retained = state.rawSlots.pending() > 0;
      if (!state.terminalFrozen) {
        const latestAction = kernel.latestAction(sessionId);
        if (latestAction === undefined) return yield* Effect.die(new Error(`session tree is empty: ${sessionId}`));
        yield* seal({
          turnId: input.turnId, resultId: input.resultId, resumeCount: input.resumeCount, boundaryActionId,
          toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration, action: latestAction,
        }, result);
      }
      if (retained) {
        state.retainedRunner = yield* Effect.forkIn(state.rawSlots.awaitSettled.pipe(
          Effect.tapError((error) => Effect.sync(() => { state.retainedFailure = error; })),
          Effect.onExit(() => Effect.gen(function* () {
            state.retainedRunner = undefined;
            yield* ports.hibernate(kernel.row(sessionId)).pipe(Effect.orDie);
          })),
        ), scope);
      }
      return result;
    });
  }

  function drainBoundary(input: TurnInput, boundary: SessionTurn.Boundary, parentActionId: string) {
    return Effect.gen(function* () {
      const observations = yield* ObservationSink;
      const pending = pendingBacklog(kernel, sessionId);
      const refusal = yield* ports.evaluatePromptPolicies(pending);
      if (refusal !== undefined) {
        yield* ports.consumePolicyBlockedInbox(pending);
        return yield* new ForeignFailure({ operation: "session.prompt", cause: refusal.reason });
      }
      const checkpointId = entropy();
      const deliveries = deliveryActions(pending, input.turnId, boundary, checkpointId);
      const checkpoint = turnCheckpointAction({
        id: checkpointId, parentId: parentActionId, sessionId, turnId: input.turnId, resultId: input.resultId,
        resumeCount: input.resumeCount, boundaryActionId: checkpointId, boundary, at: clock(),
      });
      const current = kernel.row(sessionId);
      yield* commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [checkpoint, ...deliveries],
        state: current.state === "interrupted" ? "interrupted" : "running",
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(pending, input.turnId, boundary, clock(), observations);
      return {
        messages: pending.filter((item) => item.kind === "prompt").map((item) => ({ id: item.id, role: "user" as const, text: item.content })),
        interrupted: pending.some((item) => item.kind === "interrupt"),
        parentActionId: deliveries.at(-1)?.id ?? checkpointId, boundaryActionId: checkpointId,
      };
    });
  }

  function seal(open: SessionHandleStore.OpenTurn, result: SessionRunnerResult): Effect.Effect<void, SessionError> {
    return Effect.gen(function* () {
      const current = kernel.row(sessionId);
      const latest = kernel.latestAction(sessionId);
      const interrupts = result.kind === "interrupted" ? pendingBacklog(kernel, sessionId).filter((item) => item.kind === "interrupt") : [];
      const deliveries = deliveryActions(interrupts, open.turnId, "before_llm", latest?.id ?? open.action.id);
      const terminal = turnTerminalAction({
        id: open.resultId, parentId: deliveries.at(-1)?.id ?? latest?.id ?? open.action.id,
        sessionId, turnId: open.turnId, result, resumeCount: open.resumeCount, boundaryActionId: open.boundaryActionId, at: clock(),
      });
      const reply = parentReply(kernel, current, terminal, result);
      yield* commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [...deliveries, terminal, ...(reply === undefined ? [] : [outboundOpen(reply, terminal.ts)])],
        state: result.kind === "interrupted" ? "interrupted" : "idle",
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(interrupts, open.turnId, "before_llm", clock(), runtime.observations);
      if (reply !== undefined) yield* dispatchSessionOutbound(kernel, sessionId, runtime, owner, state.fence, clock);
    });
  }
  return { runTurn, seal };
}

function withSignal<A, E, R>(work: Effect.Effect<A, E, R>, signal: AbortSignal) {
  const aborted = Effect.callback<never>((resume) => {
    const listener = () => resume(Effect.interrupt);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
    return Effect.sync(() => signal.removeEventListener("abort", listener));
  });
  return work.pipe(Effect.raceFirst(aborted));
}

function resultOf(exit: Exit.Exit<ExecutionResult, ExecutionError>, value: SessionRunnerResult): SessionRunnerResult {
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterrupts(exit.cause)) return { kind: "interrupted", text: "" };
    const cause = Option.getOrElse(Cause.findErrorOption(exit.cause), () => new ForeignFailure({ operation: "session.turn", cause: Cause.pretty(exit.cause) }));
    return { kind: "error", text: cause.message, cause };
  }
  const outcome = exit.value;
  if (outcome.terminal !== "executed") return policyRefusalResult(outcome.reason);
  if (canonicalDigest(outcome.value) === canonicalDigest(sessionRunnerResultValue(value))) return value;
  return sessionRunnerResultFromValue(outcome.value) ?? policyRefusalResult("invalid_output");
}
