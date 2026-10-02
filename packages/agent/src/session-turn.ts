import { Cause, Effect, Exit, type Scope } from "effect";
import { z } from "zod";
import type * as SessionHandleStore from "./store/fence";
import { BusEvent, canonicalDigest, Inbox, type PlainValue, type SessionGeneration, type SessionTurn, type LedgerSession } from "@openomni/protocol";
import { createExecutor, type ExecutionResult } from "./executor";
import * as Failure from "./failure";
import { interruptOn } from "./core/interrupt-on";
import { CommitFailed, AgentFailure, InboundAuthorityViolation, RunnerOutputMissing, type ExecutionError, type SessionError } from "./errors";
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
import { scopeObservation } from "./observation/bus";

const ExternalOrigin = z.object({ kind: z.literal("external") });
const FullAccessOrigin = ExternalOrigin.extend({ inboundTreatment: z.literal("full_access") });
const EvidenceOnlyOrigin = ExternalOrigin.extend({ inboundTreatment: z.literal("evidence_only") });
const SessionOrigin = z.object({ kind: z.literal("session"), id: z.string() });
/** Provenance this kernel minted itself: session handles, inter-session mail, reply terminals. */
const TrustedOrigin = z.union([SessionOrigin, Inbox.MessageOrigin, Inbox.ReplyOrigin]);

/** The violation fact published when mail of unknown provenance reaches a turn. */
export const InboundAuthorityViolated = BusEvent.define(
  "session.inbound_authority.violation",
  z.object({
    reason: z.enum(["unknown_origin", "undeclared_treatment"]),
    messageId: z.string().optional(),
  }),
  { visibility: "user_audit" },
);

export interface InboundAuthorityDecision {
  readonly authority: "act" | "evidence_only";
  readonly violation?: InboundAuthorityViolation;
}

/**
 * Turn authority from the prompt's inbox origin. A missing origin (fixture
 * prompt) or a kernel-minted origin acts; an external origin acts only when
 * the perimeter recorded `full_access` verbatim, and is evidence when it
 * recorded `evidence_only`. Everything else is mail of unknown provenance:
 * evidence authority plus a recorded violation fact — never `act`.
 */
export function inboundAuthority(origin: PlainValue | undefined): InboundAuthorityDecision {
  if (origin === undefined || TrustedOrigin.safeParse(origin).success) return { authority: "act" };
  if (ExternalOrigin.safeParse(origin).success) {
    if (FullAccessOrigin.safeParse(origin).success) return { authority: "act" };
    if (EvidenceOnlyOrigin.safeParse(origin).success) return { authority: "evidence_only" };
    return { authority: "evidence_only", violation: new InboundAuthorityViolation("undeclared_treatment") };
  }
  return { authority: "evidence_only", violation: new InboundAuthorityViolation("unknown_origin") };
}

/** The turn's result when the runner never produced one: a typed missing-output failure, not a policy refusal. */
export function runnerOutputMissingResult(turnId: string): SessionRunnerResult {
  const cause = new RunnerOutputMissing(turnId);
  return { kind: "error", text: cause.message, cause };
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
      let runnerResult: SessionRunnerResult = runnerOutputMissingResult(input.turnId);
      const body = Effect.gen(function* () {
        if (controller.signal.aborted) return yield* Effect.interrupt;
        const hydrated = hydrateSessionHistory(kernel, sessionId);
        const promptId = hydrated.messages.filter((message) => message.role === "user").at(-1)?.id;
        const origin = receivedMessages(kernel, sessionId).rows.find((item) => item.id === promptId)?.origin;
        const inbound = inboundAuthority(origin?.value);
        if (inbound.violation !== undefined) {
          const observations = yield* ObservationSink;
          scopeObservation(observations, { sessionId, turnId: input.turnId }, { now: clock, id: entropy }).publish(
            InboundAuthorityViolated,
            { reason: inbound.violation.reason, ...(promptId === undefined ? {} : { messageId: promptId }) },
          );
        }
        runnerResult = yield* runner({
          authority: inbound.authority,
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
        return yield* new AgentFailure({ operation: "session.prompt", cause: refusal.reason });
      }
      const checkpointId = entropy();
      const deliveries = deliveryActions(
        pending,
        { kind: "turn", turnId: input.turnId },
        boundary,
        checkpointId,
      );
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
      observeDrained(pending, input.turnId, boundary, clock(), observations, entropy);
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
      const deliveries = deliveryActions(
        interrupts,
        { kind: "turn", turnId: open.turnId },
        "before_llm",
        latest?.id ?? open.action.id,
      );
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
      observeDrained(interrupts, open.turnId, "before_llm", clock(), runtime.observations, runtime.entropy);
      if (reply !== undefined) yield* dispatchSessionOutbound(kernel, sessionId, runtime, owner, state.fence, clock);
    });
  }
  return { runTurn, seal };
}

function withSignal<A, E, R>(work: Effect.Effect<A, E, R>, signal: AbortSignal) {
  return work.pipe(Effect.raceFirst(interruptOn(signal)));
}

function resultOf(exit: Exit.Exit<ExecutionResult, ExecutionError>, value: SessionRunnerResult): SessionRunnerResult {
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterrupts(exit.cause)) return { kind: "interrupted", text: "" };
    const cause = Failure.of(exit.cause, "session.turn");
    return { kind: "error", text: cause.message, cause };
  }
  const outcome = exit.value;
  if (outcome.terminal !== "executed") return policyRefusalResult(outcome.reason);
  if (canonicalDigest(outcome.value) === canonicalDigest(sessionRunnerResultValue(value))) return value;
  return sessionRunnerResultFromValue(outcome.value) ?? policyRefusalResult("invalid_output");
}
