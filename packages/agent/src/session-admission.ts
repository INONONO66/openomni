import { Effect } from "effect";
import { CommitRefused, SessionHandleStore, type LedgerError } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import {
  canonicalDigest,
  type SessionGeneration,
  type SessionTransition,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type PlainValue,
} from "@openomni/protocol";
import { createExecutor, type ExecutionResult } from "./executor";
import { recordedCompaction, restoreContextRequest, restoredContextProjection } from "./compaction/restore";
import { ForeignFailure, CommitFailed, type ExecutionError, type SessionError } from "./errors";
import {
  SessionPolicyRefusal,
  type SessionRuntime,
  type SessionRunnerResult,
  type SessionActionCommitPort,
} from "./session-contract";
import {
  latestTerminal,
  requireCommit,
  turnIntentAction,
  turnResumeAction,
  deliveryActions,
  policyRefusalResult,
  generationForOpen,
} from "./session-record";
import type { SessionControllerState } from "./session-controller-state";
import { observeDrained } from "./session-message-observation";
import { decideRequestTransition, type RequestDecision } from "./session-request";

type AdmissionError = SessionError;

export function createSessionAdmission(
  sessionId: string,
  runtime: SessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  pinPolicy: (generation: number) => CompiledPolicySnapshot,
  ports: {
    readonly awaitRetainedRunner: () => Effect.Effect<void, AdmissionError>;
    readonly acquire: (expectedFence: number) => Effect.Effect<number, AdmissionError>;
    readonly runTurn: (input: {
      readonly turnId: string;
      readonly resultId: string;
      readonly parentActionId: string;
      readonly boundaryActionId: string | null;
      readonly resumeCount: number;
      readonly generation: SessionGeneration.Snapshot;
      readonly resume: boolean;
    }) => Effect.Effect<SessionRunnerResult, AdmissionError>;
    readonly seal: (
      open: SessionHandleStore.OpenTurn,
      result: SessionRunnerResult,
      releaseLease: boolean,
    ) => Effect.Effect<void, AdmissionError>;
    readonly releaseHeldLease: () => Effect.Effect<void, ExecutionError>;
  },
) {
  const { awaitRetainedRunner, acquire, runTurn, seal, releaseHeldLease } = ports;

  function commitSession(input: {
    readonly expectedRevision: number;
    readonly actions: readonly LedgerAction.Append[];
    readonly consumeInboxIds: readonly string[];
    readonly state: LedgerSession.State;
    readonly releaseLease: boolean;
    readonly generation?: LedgerSession.GenerationPointers;
  }): Effect.Effect<Extract<LedgerSession.CommitResult, { readonly ok: true }>, LedgerError> {
    return SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: input.expectedRevision,
      actions: [...input.actions],
      consumeInboxIds: [...input.consumeInboxIds],
      state: input.state,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      releaseLease: input.releaseLease,
    }).pipe(Effect.map((result) => {
      requireCommit(result);
      return result;
    }));
  }

  function startTurn(): Effect.Effect<SessionRunnerResult | undefined, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const current = SessionHandleStore.row(sessionId);
      state.fence = yield* acquire(current.leaseFence);
      const actions = SessionHandleStore.tree(sessionId);
      const generation = SessionHandleStore.latestGeneration(actions);
      const pending = SessionHandleStore.pendingInbox(sessionId);
      const promptRefusal = yield* evaluatePromptPolicies(pending, pinPolicy(generation.policyGeneration));
      if (promptRefusal !== undefined) {
        yield* consumePolicyBlockedInbox(pending, true);
        return policyRefusalResult(promptRefusal.reason);
      }
      const resultId = entropy();
      const turnId = entropy();
      const parentActionId = SessionHandleStore.tree(sessionId).at(-1)?.id ?? null;
      const deliveries = deliveryActions(pending, turnId, "before_llm", parentActionId);
      const envelope = turnIntentAction({
        id: turnId,
        parentId: deliveries.at(-1)?.id ?? parentActionId,
        sessionId,
        resultId,
        inboxIds: pending.map((item) => item.id),
        generation,
        resumeCount: 0,
        boundaryActionId: parentActionId,
        at: clock(),
      });
      yield* commitSession({
        expectedRevision: SessionHandleStore.row(sessionId).revision,
        actions: [...deliveries, envelope],
        consumeInboxIds: pending.map((item) => item.id),
        state: "running",
        releaseLease: false,
      });
      observeDrained(pending, turnId, "before_llm", clock(), runtime.observations);
      if (pending.some((item) => item.kind === "interrupt")) {
        const action = SessionHandleStore.tree(sessionId).find((item) => item.id === turnId);
        if (action === undefined) return yield* new ForeignFailure({ operation: "session.turn", cause: `missing_turn:${turnId}` });
        yield* seal({
          turnId,
          resultId,
          resumeCount: 0,
          boundaryActionId: parentActionId,
          toolsGeneration: generation.generation,
          toolsHash: generation.toolsHash,
          systemHash: generation.systemHash,
          policyGeneration: generation.policyGeneration,
          action,
        }, { kind: "interrupted" }, true);
        return { kind: "interrupted" as const };
      }
      return yield* runTurn({
        turnId,
        resultId,
        parentActionId: envelope.id,
        boundaryActionId: parentActionId,
        resumeCount: 0,
        generation,
        resume: false,
      });
    });
  }

  function evaluatePromptPolicies(
    items: readonly Inbox.Row[],
    policy: CompiledPolicySnapshot,
  ): Effect.Effect<SessionPolicyRefusal | undefined, ExecutionError> {
    return Effect.gen(function* () {
      const ledger = createExecutionLedger();
      let refusal: SessionPolicyRefusal | undefined;
      for (const item of items) {
        if (item.kind !== "prompt") continue;
        const recorded: PlainValue = { inboxId: item.id, status: "recorded" };
        const outcome = yield* createExecutor({
          policy,
          ledger,
          observations: runtime.observations,
          identity: { sessionId, role: SessionHandleStore.row(sessionId).role, parentActionId: item.id },
          clock,
          entropy,
        }).runExisting({
          kind: "prompt",
          op: "inbox",
          intent: { inboxId: item.id, content: item.content, origin: item.origin.value, createdAt: item.createdAt, ordinal: item.ordinal },
          effect: { status: "recorded" },
        }, () => Effect.succeed(recorded));
        if (refusal !== undefined) continue;
        if (outcome.terminal !== "executed") refusal = new SessionPolicyRefusal(outcome.reason);
        else if (canonicalDigest(outcome.value) !== canonicalDigest(recorded)) refusal = new SessionPolicyRefusal("invalid_output");
      }
      return refusal;
    });
  }

  function consumePolicyBlockedInbox(items: readonly Inbox.Row[], releaseLease: boolean): Effect.Effect<void, ExecutionError> {
    const current = SessionHandleStore.row(sessionId);
    return commitSession({
      expectedRevision: current.revision,
      actions: [],
      consumeInboxIds: items.map((item) => item.id),
      state: current.state,
      releaseLease,
    }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid);
  }

  function createExecutionLedger(turnId?: string): SessionActionCommitPort {
    const executionFence = state.fence;
    return {
      actions: () => SessionHandleStore.tree(sessionId),
      validateRequest(request) {
        const row = SessionHandleStore.row(sessionId);
        return row.leaseOwner === owner && row.leaseFence === executionFence && row.leaseExpiresAt !== null &&
          clock() < row.leaseExpiresAt && row.toolsGeneration === request.toolsGeneration &&
          row.systemHash === request.systemHash && row.policyGeneration === request.generation &&
          (runtime.requestDomainRevisions === undefined || canonicalDigest({ ...runtime.requestDomainRevisions(request) }) === canonicalDigest(request.domainRevisions));
      },
      transition(payload, inputId, at) {
        return Effect.gen(function* () {
          const current = SessionHandleStore.row(sessionId);
          if (current.leaseFence !== executionFence || (turnId !== undefined && SessionHandleStore.tree(sessionId).some((node) => SessionHandleStore.turnTerminal(node)?.turnId === turnId)))
            return yield* new ForeignFailure({ operation: "session.request.transition", cause: "stale" });
          return yield* commitSessionRequest(sessionId, { owner, fence: executionFence }, payload, inputId, at, runtime);
        });
      },
      commit(action) {
        return Effect.gen(function* () {
          const current = SessionHandleStore.row(sessionId);
          const sealed = turnId !== undefined && SessionHandleStore.tree(sessionId).some((node) => SessionHandleStore.turnTerminal(node)?.turnId === turnId);
          if (current.leaseFence !== executionFence || sealed || state.terminalFrozen) return yield* new CommitRefused({
            sessionId, reason: "fence", expectedRevision: current.revision,
            currentRevision: current.revision, fence: executionFence, currentFence: current.leaseFence,
          });
          const committed = yield* commitSession({ expectedRevision: current.revision, actions: [action], consumeInboxIds: [], state: current.state, releaseLease: false });
          const receipt = committed.receipts[0];
          if (receipt === undefined) return yield* new ForeignFailure({ operation: "session.commit", cause: "missing_receipt" });
          return receipt;
        });
      },
    };
  }

  function restoreContextProjection(compactionId: string): Effect.Effect<ExecutionResult, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const current = SessionHandleStore.row(sessionId);
      state.fence = yield* acquire(current.leaseFence);
      return yield* Effect.gen(function* () {
        const actions = SessionHandleStore.tree(sessionId);
        const record = recordedCompaction(actions, compactionId);
        const executor = createExecutor({
          policy: pinPolicy(SessionHandleStore.latestGeneration(actions).policyGeneration),
          ledger: createExecutionLedger(),
          observations: runtime.observations,
          clock,
          entropy,
          identity: { sessionId, role: current.role, parentActionId: compactionId },
        });
        return yield* executor.run(restoreContextRequest(compactionId), () => Effect.succeed(restoredContextProjection(sessionId, actions, compactionId, record)));
      }).pipe(Effect.onExit(() => releaseHeldLease().pipe(Effect.orDie)));
    });
  }

  function resumeTurn(open: SessionHandleStore.OpenTurn): Effect.Effect<SessionRunnerResult, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      state.fence = yield* acquire(SessionHandleStore.row(sessionId).leaseFence);
      if (SessionHandleStore.pendingInbox(sessionId).some((item) => item.kind === "interrupt")) {
        const interrupted = { kind: "interrupted" as const };
        yield* seal(open, interrupted, true);
        return interrupted;
      }
      if (open.resumeCount >= SessionHandleStore.RESUME_BUDGET) {
        const exhausted = { kind: "error" as const, text: "session resume budget exhausted" };
        yield* seal(open, exhausted, true);
        return exhausted;
      }
      const generation = yield* generationForOpen(open);
      const resumeCount = open.resumeCount + 1;
      const resumeId = entropy();
      const resultId = open.resultId;
      const resume = turnResumeAction({ id: resumeId, parentId: open.boundaryActionId ?? open.action.id, sessionId, turnId: open.turnId, resultId, generation, resumeCount, boundaryActionId: open.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: SessionHandleStore.row(sessionId).revision, actions: [resume], consumeInboxIds: [], state: "running", releaseLease: false });
      return yield* runTurn({ turnId: open.turnId, resultId, parentActionId: resumeId, boundaryActionId: open.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  function resumeInterrupted(item: Inbox.Row): Effect.Effect<SessionRunnerResult | undefined, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const terminal = latestTerminal(SessionHandleStore.tree(sessionId));
      if (terminal === undefined) {
        yield* consumeNoopInbox([item]);
        return undefined;
      }
      const current = SessionHandleStore.row(sessionId);
      state.fence = yield* acquire(current.leaseFence);
      const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
      const resultId = entropy();
      const turnId = entropy();
      const resumeCount = terminal.effect.resumeCount + 1;
      const delivery = deliveryActions([item], turnId, "before_llm", terminal.action.id);
      const resume = turnIntentAction({ id: turnId, parentId: delivery.at(-1)?.id ?? terminal.action.id, sessionId, resultId, inboxIds: [item.id], generation, resumeCount, boundaryActionId: terminal.effect.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: current.revision, actions: [...delivery, resume], consumeInboxIds: [item.id], state: "running", releaseLease: false });
      return yield* runTurn({ turnId, resultId, parentActionId: resume.id, boundaryActionId: terminal.effect.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  function consumeNoopInbox(items: readonly Inbox.Row[]): Effect.Effect<void, AdmissionError> {
    return Effect.gen(function* () {
      const current = SessionHandleStore.row(sessionId);
      state.fence = yield* acquire(current.leaseFence);
      const noops = deliveryActions(items, "noop", "before_llm", SessionHandleStore.tree(sessionId).at(-1)?.id ?? null);
      yield* commitSession({ expectedRevision: current.revision, actions: noops, consumeInboxIds: items.map((item) => item.id), state: current.state, releaseLease: true });
    });
  }

  return { startTurn, evaluatePromptPolicies, consumePolicyBlockedInbox, commitSession, createExecutionLedger, resumeTurn, resumeInterrupted, consumeNoopInbox, restoreContextProjection };
}

function requestIdentity(payload: SessionTransition.Payload): string {
  switch (payload.kind) {
    case "request.open": return payload.request.requestId;
    case "request.answer": return payload.answer.requestId;
    case "request.delivery": return payload.receipt.requestId;
    default: return payload.requestId;
  }
}

export function commitSessionRequest(
  sessionId: string,
  authority: { owner: string; fence: number },
  payload: SessionTransition.Payload,
  inputId: string,
  at: number,
  runtime: SessionRuntime,
  admission?: Inbox.Commit,
): Effect.Effect<RequestDecision, ExecutionError> {
  return Effect.gen(function* () {
    const row = SessionHandleStore.row(sessionId);
    const requestId = requestIdentity(payload);
    const request = SessionHandleStore.requestById(requestId);
    const decision = decideRequestTransition({ version: 1, sessionId, inputId, at, expectedRevision: row.revision, authority, payload }, {
      row,
      actions: SessionHandleStore.tree(sessionId),
      request,
      requests: SessionHandleStore.requestRows(),
      domainRevisions: request === undefined ? undefined : runtime.requestDomainRevisions?.(request),
    });
    if (decision.actions.length > 0) {
      yield* SessionHandleStore.commitRequestTransition({
        sessionId,
        ...authority,
        now: at,
        expectedRevision: row.revision,
        actions: [...decision.actions],
        consumeInboxIds: [],
        state: row.state,
        releaseLease: false,
        ...(decision.receive === undefined ? {} : { receive: decision.receive }),
        ...(decision.requestCount === undefined ? {} : { requestCount: decision.requestCount }),
        ...(admission === undefined ? {} : { admit: admission }),
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.map(requireCommit));
    }
    return decision;
  });
}
