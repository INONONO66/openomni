import { Cause, Effect, Exit, Fiber, Option, type Scope } from "effect";
import { z } from "zod";
import { SessionHandleStore } from "@openomni/ledger";
import { canonicalDigest, type PlainValue, type SessionGeneration, type SessionTurn, type Inbox, type LedgerSession } from "@openomni/protocol";
import { createExecutor, type ExecutionResult } from "./executor";
import { CommitFailed, ForeignFailure, type ExecutionError, type SessionError } from "./errors";
import { hydrateSessionHistory } from "./session-lifecycle/history";
import { commitFoldBatch } from "./session-fold-commit";
import { sessionStopEvidence } from "./session-stop-evidence";
import type { SessionPolicyRefusal, ResolvedSessionRuntime, SessionRunner, SessionRunnerResult, SessionActionCommitPort, SessionBoundaryResult } from "./session-contract";
import { turnCheckpointAction, deliveryActions, turnTerminalAction, policyRefusalResult, sessionRunnerResultValue, sessionRunnerResultFromValue } from "./session-record";
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
  sessionId: string,
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  scheduleHeartbeat: (callback: () => void, intervalMs: number) => () => void,
  scope: Scope.Scope,
  ports: {
    readonly createExecutionLedger: (turnId?: string) => SessionActionCommitPort;
    readonly evaluatePromptPolicies: (items: readonly Inbox.Row[]) => Effect.Effect<SessionPolicyRefusal | undefined, ExecutionError, RunnerServices>;
    readonly consumePolicyBlockedInbox: (items: readonly Inbox.Row[], releaseLease: boolean) => Effect.Effect<void, ExecutionError>;
    readonly releaseHeldLease: () => Effect.Effect<void, ExecutionError>;
    readonly hibernate: (current: LedgerSession.Row) => Effect.Effect<void, SessionError>;
  },
) {
  function heartbeat(controller: AbortController) {
    const tick = Effect.async<void>((resume) => {
      const cancel = scheduleHeartbeat(() => resume(Effect.void), SessionHandleStore.HEARTBEAT_INTERVAL_MS);
      return Effect.sync(cancel);
    });
    return Effect.forever(tick.pipe(Effect.andThen(() => {
      const now = clock();
      return SessionHandleStore.renewLease({ sessionId, owner, fence: state.fence, now, expiresAt: now + SessionHandleStore.LEASE_TTL_MS });
    }))).pipe(Effect.tapError(() => Effect.sync(() => controller.abort())));
  }

  const stopHeartbeat = () => Effect.suspend(() => {
    const fiber = state.heartbeat;
    state.heartbeat = undefined;
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid);
  });

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
      const row = SessionHandleStore.row(sessionId);
      const controller = new AbortController();
      state.controller = controller;
      state.heartbeat = yield* Effect.forkIn(heartbeat(controller), scope);
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
        const hydrated = hydrateSessionHistory(sessionId);
        const promptId = hydrated.messages.filter((message) => message.role === "user").at(-1)?.id;
        const origin = SessionHandleStore.inboxRows(sessionId).find((item) => item.id === promptId)?.origin;
        runnerResult = yield* runner({
          authority: inboundAuthority(origin?.value),
          sessionId, role: row.role, turnId: input.turnId, actionId: input.parentActionId,
          ledger, retainEffect, bindApprovals: (approvals) => { state.activeApprovals = approvals; },
          stopEvidence: sessionStopEvidence(sessionId, input.turnId, () => state.activeApprovals, runtime.openIntent),
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
      // A raw slot, unlike its fiber, can outlive interruption. Its renewal and
      // generation remain owned by the app Scope until actual raw settlement.
      const retained = state.rawSlots.pending() > 0;
      if (!retained) yield* stopHeartbeat();
      if (!state.terminalFrozen) {
        const latestAction = SessionHandleStore.latestAction(sessionId);
        if (latestAction === undefined) return yield* Effect.die(new Error(`session tree is empty: ${sessionId}`));
        yield* seal({
          turnId: input.turnId, resultId: input.resultId, resumeCount: input.resumeCount, boundaryActionId,
          toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration, action: latestAction,
        }, result, !retained);
      } else if (!retained) {
        // Shutdown may seal while the raw callback settles. No retained waiter
        // exists in that ordering, so this turn must release its own fence.
        yield* ports.releaseHeldLease();
      }
      if (retained) {
        state.retainedRunner = yield* Effect.forkIn(state.rawSlots.awaitSettled.pipe(
          Effect.andThen(stopHeartbeat),
          Effect.andThen(ports.releaseHeldLease),
          Effect.tapError((error) => Effect.sync(() => { state.retainedFailure = error; })),
          Effect.onExit(() => Effect.gen(function* () {
            state.retainedRunner = undefined;
            yield* ports.hibernate(SessionHandleStore.row(sessionId)).pipe(Effect.orDie);
          })),
        ), scope);
      }
      return result;
    });
  }

  function drainBoundary(input: TurnInput, boundary: SessionTurn.Boundary, parentActionId: string) {
    return Effect.gen(function* () {
      const observations = yield* ObservationSink;
      const pending = SessionHandleStore.pendingInbox(sessionId);
      const refusal = yield* ports.evaluatePromptPolicies(pending);
      if (refusal !== undefined) {
        yield* ports.consumePolicyBlockedInbox(pending, false);
        return yield* new ForeignFailure({ operation: "session.prompt", cause: refusal.reason });
      }
      const checkpointId = entropy();
      const deliveries = deliveryActions(pending, input.turnId, boundary, checkpointId);
      const checkpoint = turnCheckpointAction({
        id: checkpointId, parentId: parentActionId, sessionId, turnId: input.turnId, resultId: input.resultId,
        resumeCount: input.resumeCount, boundaryActionId: checkpointId, boundary, at: clock(),
      });
      const current = SessionHandleStore.row(sessionId);
      yield* commitFoldBatch({
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [checkpoint, ...deliveries], consumeInboxIds: pending.map((item) => item.id),
        state: current.state === "interrupted" ? "interrupted" : "running", releaseLease: false,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(pending, input.turnId, boundary, clock(), observations);
      return {
        messages: pending.filter((item) => item.kind === "prompt").map((item) => ({ id: item.id, role: "user" as const, text: item.content })),
        interrupted: pending.some((item) => item.kind === "interrupt"),
        parentActionId: deliveries.at(-1)?.id ?? checkpointId, boundaryActionId: checkpointId,
      };
    });
  }

  function seal(open: SessionHandleStore.OpenTurn, result: SessionRunnerResult, releaseLease: boolean): Effect.Effect<void, SessionError> {
    return Effect.gen(function* () {
      const current = SessionHandleStore.row(sessionId);
      const latest = SessionHandleStore.latestAction(sessionId);
      const interrupts = result.kind === "interrupted" ? SessionHandleStore.pendingInbox(sessionId).filter((item) => item.kind === "interrupt") : [];
      const deliveries = deliveryActions(interrupts, open.turnId, "before_llm", latest?.id ?? open.action.id);
      const terminal = turnTerminalAction({
        id: open.resultId, parentId: deliveries.at(-1)?.id ?? latest?.id ?? open.action.id,
        sessionId, turnId: open.turnId, result, resumeCount: open.resumeCount, boundaryActionId: open.boundaryActionId, at: clock(),
      });
      const reply = parentReply(current, terminal, result);
      yield* commitFoldBatch({
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [...deliveries, terminal, ...(reply === undefined ? [] : [outboundOpen(reply, terminal.ts)])],
        consumeInboxIds: interrupts.map((item) => item.id), state: result.kind === "interrupted" ? "interrupted" : "idle",
        releaseLease: reply === undefined && releaseLease,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(interrupts, open.turnId, "before_llm", clock(), runtime.observations);
      if (reply !== undefined) yield* dispatchSessionOutbound(sessionId, runtime, owner, state.fence, clock, releaseLease);
    });
  }
  return { runTurn, seal };
}

function withSignal<A, E, R>(work: Effect.Effect<A, E, R>, signal: AbortSignal) {
  const aborted = Effect.async<never>((resume) => {
    const listener = () => resume(Effect.interrupt);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
    return Effect.sync(() => signal.removeEventListener("abort", listener));
  });
  return work.pipe(Effect.raceFirst(aborted));
}

function resultOf(exit: Exit.Exit<ExecutionResult, ExecutionError>, value: SessionRunnerResult): SessionRunnerResult {
  if (Exit.isFailure(exit)) {
    if (Cause.isInterrupted(exit.cause)) return { kind: "interrupted", text: "" };
    const cause = Option.getOrElse(Cause.failureOption(exit.cause), () => new ForeignFailure({ operation: "session.turn", cause: Cause.pretty(exit.cause) }));
    return { kind: "error", text: cause.message, cause };
  }
  const outcome = exit.value;
  if (outcome.terminal !== "executed") return policyRefusalResult(outcome.reason);
  if (canonicalDigest(outcome.value) === canonicalDigest(sessionRunnerResultValue(value))) return value;
  return sessionRunnerResultFromValue(outcome.value) ?? policyRefusalResult("invalid_output");
}
