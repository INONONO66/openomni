import { Effect } from "effect";
import { CommitRefused, LedgerFailure, SessionHandleStore, type CommitReceipt, type LedgerError } from "@openomni/ledger";
import { ObservationSink, type RunnerServices } from "./services";
import {
  canonicalDigest,
  PlainValueSchema,
  type SessionGeneration,
  type SessionTransition,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type PlainValue,
} from "@openomni/protocol";
import { createExecutor, type ExecutionResult } from "./executor";
import { recordedCompaction, requireCompactionIntent, restoreContextRequest, restoredContextProjection } from "./compaction/restore";
import { AgentFailure, CommitFailed, type ExecutionError, type SessionError } from "./errors";
import {
  SessionPolicyRefusal,
  type SessionRuntime,
  type ResolvedSessionRuntime,
  type SessionRunnerResult,
  type SessionActionCommitPort,
} from "./session-contract";
import type { SessionKernel } from "./cluster/kernel-registry";
import {
  turnIntentAction,
  turnResumeAction,
  deliveryActions,
  policyRefusalResult,
  generationForOpen,
  pendingBacklog,
  receivedMessageAction,
} from "./session-record";
import type { SessionControllerState } from "./session-controller-state";
import { observeDrained } from "./session-message-observation";
import { decideRequestTransition, type RequestDecision } from "./session-request";

import { commitFoldBatch } from "./session-fold-commit";
import { hydrateSessionHistory } from "./session-lifecycle/history";

type AdmissionError = SessionError;

interface AdmissionSnapshot {
  readonly row: LedgerSession.Row;
  readonly pending: readonly Inbox.Row[];
  readonly open?: SessionHandleStore.OpenTurn;
  readonly terminal?: ReturnType<SessionKernel["latestTurnTerminal"]>;
}

type AdmissionDecision =
  | { readonly kind: "stop" | "refused" | "start" }
  | { readonly kind: "recover"; readonly open: SessionHandleStore.OpenTurn }
  | { readonly kind: "resume"; readonly item: Inbox.Row }
  | { readonly kind: "consume"; readonly items: readonly Inbox.Row[] };

/** Pure routing of the durable S/T/I views; dispatch remains behind the ledger CAS. */
export function decideSessionAdmission(snapshot: AdmissionSnapshot): AdmissionDecision {
  const { row, pending, open, terminal } = snapshot;
  if (pending.some((item) => item.sessionId !== row.id || item.status !== "pending")) return { kind: "refused" };
  if (open !== undefined && open.action.sessionId !== row.id) return { kind: "refused" };
  if (terminal !== undefined && terminal.action.sessionId !== row.id) return { kind: "refused" };
  switch (row.state) {
    case "running":
      return open === undefined ? { kind: "refused" } : { kind: "recover", open };
    case "interrupted": {
      if (open !== undefined) return { kind: "recover", open };
      const item = pending.find((input) => input.kind === "resume");
      if (item === undefined) return { kind: "stop" };
      return terminal?.effect.kind === "interrupted"
        ? { kind: "resume", item }
        : { kind: "consume", items: [item] };
    }
    case "idle":
      return open === undefined ? decideIdleInbox(pending) : { kind: "refused" };
  }
}

function decideIdleInbox(pending: readonly Inbox.Row[]): AdmissionDecision {
  if (pending.length === 0) return { kind: "stop" };
  const firstPrompt = pending.findIndex((item) => item.kind === "prompt");
  if (firstPrompt === 0) return { kind: "start" };
  return { kind: "consume", items: firstPrompt > 0 ? pending.slice(0, firstPrompt) : pending };
}

export function createSessionAdmission(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  ports: {
    readonly awaitRetainedRunner: () => Effect.Effect<void, AdmissionError>;
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
    ) => Effect.Effect<void, AdmissionError>;
  },
) {
  const { awaitRetainedRunner, runTurn, seal } = ports;

  function commitSession(input: {
    readonly expectedRevision: number;
    readonly actions: readonly LedgerAction.Append[];
    readonly state: LedgerSession.State;
    readonly generation?: LedgerSession.GenerationPointers;
  }): Effect.Effect<CommitReceipt, LedgerError> {
    return commitFoldBatch(kernel, {
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: input.expectedRevision,
      actions: [...input.actions],
      state: input.state,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    });
  }

  function startTurn(): Effect.Effect<SessionRunnerResult | undefined, AdmissionError> {
    return Effect.scoped(Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const generation = kernel.latestGenerationFor(sessionId);
      const captured = yield* runtime.generations.capture({ sessionId, generation: generation.generation });
      const observations = yield* captured.provide(ObservationSink);
      const pending = pendingBacklog(kernel, sessionId);
      const promptRefusal = yield* captured.provide(evaluatePromptPolicies(pending)).pipe(Effect.provide(runtime.services));
      if (promptRefusal !== undefined) {
        yield* consumePolicyBlockedInbox(pending);
        return policyRefusalResult(promptRefusal.reason);
      }
      const resultId = entropy();
      const turnId = entropy();
      const parentActionId = kernel.latestAction(sessionId)?.id ?? null;
      const deliveries = deliveryActions(
        pending,
        { kind: "turn", turnId },
        "before_llm",
        parentActionId,
      );
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
        expectedRevision: kernel.row(sessionId).revision,
        actions: [...deliveries, envelope],
        state: "running",
      });
      observeDrained(pending, turnId, "before_llm", clock(), observations);
      if (pending.some((item) => item.kind === "interrupt")) {
        const action = kernel.actionById(turnId);
        if (action === undefined) return yield* new AgentFailure({ operation: "session.turn", cause: `missing_turn:${turnId}` });
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
        }, { kind: "interrupted" });
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
    }));
  }

  function evaluatePromptPolicies(
    items: readonly Inbox.Row[],
  ): Effect.Effect<SessionPolicyRefusal | undefined, ExecutionError, RunnerServices> {
    return Effect.gen(function* () {
      const ledger = createExecutionLedger();
      let refusal: SessionPolicyRefusal | undefined;
      for (const item of items) {
        if (item.kind !== "prompt") continue;
        const recorded: PlainValue = { inboxId: item.id, status: "recorded" };
        const executor = yield* createExecutor({
          ledger,
          identity: { sessionId, role: kernel.row(sessionId).role, parentActionId: item.id },
        });
        const outcome = yield* executor.runExisting({
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

  /** Blocked items leave the pending fold through committed no-op deliveries. */
  function consumePolicyBlockedInbox(items: readonly Inbox.Row[]): Effect.Effect<void, ExecutionError> {
    return Effect.suspend(() => {
      const current = kernel.row(sessionId);
      return commitSession({
        expectedRevision: current.revision,
        actions: deliveryActions(
          items,
          { kind: "inbox" },
          "before_llm",
          kernel.latestAction(sessionId)?.id ?? null,
        ),
        state: current.state,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid);
    });
  }

  function createExecutionLedger(turnId?: string): SessionActionCommitPort {
    const executionFence = state.fence;
    return {
      actionById: kernel.actionById,
      requestById: kernel.requestById,
      resultFor: (id) => kernel.resultFor(sessionId, id),
      openOperationsPage: (id, cursor) => kernel.openOperationsPage(sessionId, id, cursor),
      operationChildrenPage: (id, cursor) => kernel.operationChildrenPage(sessionId, id, cursor),
      guardedOperationsPage: (id, cursor) => kernel.guardedOperationsPage(sessionId, id, cursor),
      validateRequest(request) {
        const row = kernel.row(sessionId);
        return row.leaseOwner === owner && row.leaseFence === executionFence &&
          row.toolsGeneration === request.toolsGeneration &&
          row.systemHash === request.systemHash && row.policyGeneration === request.generation &&
          (runtime.requestDomainRevisions === undefined || canonicalDigest({ ...runtime.requestDomainRevisions(request) }) === canonicalDigest(request.domainRevisions));
      },
      transition(payload, inputId, at) {
        return Effect.gen(function* () {
          const current = kernel.row(sessionId);
          if (current.leaseFence !== executionFence || (turnId !== undefined && kernel.turnTerminalFor(sessionId, turnId) !== undefined))
            return yield* new AgentFailure({ operation: "session.request.transition", cause: "stale" });
          return yield* commitSessionRequest(kernel, sessionId, { owner, fence: executionFence }, payload, inputId, at, runtime);
        });
      },
      commit(action) {
        return Effect.gen(function* () {
          const current = kernel.row(sessionId);
          const sealed = turnId !== undefined && kernel.turnTerminalFor(sessionId, turnId) !== undefined;
          if (current.leaseFence !== executionFence || sealed || state.terminalFrozen) return yield* new CommitRefused({
            sessionId, reason: "fence", expectedRevision: current.revision,
            currentRevision: current.revision, fence: executionFence, currentFence: current.leaseFence,
          });
          const committed = yield* commitSession({ expectedRevision: current.revision, actions: [action], state: current.state });
          const receipt = committed.receipts[0];
          if (receipt === undefined) return yield* new LedgerFailure({ operation: "session.commit", cause: "missing_receipt" });
          return receipt;
        });
      },
    };
  }

  function restoreContextProjection(compactionId: string): Effect.Effect<ExecutionResult, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const current = kernel.row(sessionId);
      return yield* Effect.scoped(Effect.gen(function* () {
        const source = yield* requireCompactionIntent(kernel.actionById(compactionId));
        if (source.sessionId !== sessionId) return yield* new AgentFailure({ operation: "session.restore", cause: "foreign_compaction" });
        const record = yield* recordedCompaction(compactionId, kernel.resultFor(sessionId, compactionId));
        const history = hydrateSessionHistory(kernel, sessionId).history;
        const restored = restoredContextProjection(history, compactionId, record);
        const projectionHash = canonicalDigest({ foldVersion: 1, projection: PlainValueSchema.parse(history) });
        const captured = yield* runtime.generations.capture({ sessionId, generation: kernel.latestGenerationFor(sessionId).generation });
        const executor = yield* captured.provide(createExecutor({
          ledger: createExecutionLedger(),
          identity: { sessionId, role: current.role, parentActionId: compactionId },
        })).pipe(Effect.provide(runtime.services));
        return yield* captured.provide(executor.run(restoreContextRequest(compactionId, projectionHash), () => Effect.succeed(restored)));
      }));
    });
  }

  function resumeTurn(open: SessionHandleStore.OpenTurn): Effect.Effect<SessionRunnerResult, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      if (pendingBacklog(kernel, sessionId).some((item) => item.kind === "interrupt")) {
        const interrupted = { kind: "interrupted" as const };
        yield* seal(open, interrupted);
        return interrupted;
      }
      if (open.resumeCount >= SessionHandleStore.RESUME_BUDGET) {
        const exhausted = { kind: "error" as const, text: "session resume budget exhausted" };
        yield* seal(open, exhausted);
        return exhausted;
      }
      const generation = yield* generationForOpen(kernel, open);
      const resumeCount = open.resumeCount + 1;
      const resumeId = entropy();
      const resultId = open.resultId;
      const resume = turnResumeAction({ id: resumeId, parentId: open.boundaryActionId ?? open.action.id, sessionId, turnId: open.turnId, resultId, generation, resumeCount, boundaryActionId: open.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: kernel.row(sessionId).revision, actions: [resume], state: "running" });
      return yield* runTurn({ turnId: open.turnId, resultId, parentActionId: resumeId, boundaryActionId: open.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  function resumeInterrupted(item: Inbox.Row): Effect.Effect<SessionRunnerResult | undefined, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const terminal = kernel.latestTurnTerminal(sessionId);
      if (terminal?.effect.kind !== "interrupted") {
        yield* consumeNoopInbox([item]);
        return undefined;
      }
      const current = kernel.row(sessionId);
      const generation = kernel.latestGenerationFor(sessionId);
      const resultId = entropy();
      const turnId = entropy();
      const resumeCount = terminal.effect.resumeCount + 1;
      const delivery = deliveryActions(
        [item],
        { kind: "turn", turnId },
        "before_llm",
        terminal.action.id,
      );
      const resume = turnIntentAction({ id: turnId, parentId: delivery.at(-1)?.id ?? terminal.action.id, sessionId, resultId, inboxIds: [item.id], generation, resumeCount, boundaryActionId: terminal.effect.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: current.revision, actions: [...delivery, resume], state: "running" });
      return yield* runTurn({ turnId, resultId, parentActionId: resume.id, boundaryActionId: terminal.effect.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  function consumeNoopInbox(items: readonly Inbox.Row[]): Effect.Effect<void, AdmissionError> {
    return Effect.gen(function* () {
      const current = kernel.row(sessionId);
      const noops = deliveryActions(
        items,
        { kind: "inbox" },
        "before_llm",
        kernel.latestAction(sessionId)?.id ?? null,
      );
      yield* commitSession({ expectedRevision: current.revision, actions: noops, state: current.state });
    });
  }

  return { startTurn, evaluatePromptPolicies, consumePolicyBlockedInbox, commitSession, createExecutionLedger, resumeTurn, resumeInterrupted, consumeNoopInbox, restoreContextProjection };
}

function requestIdentity(payload: SessionTransition.Payload): string {
  switch (payload.kind) {
    case "request.open": return payload.request.requestId;
    case "request.answer": return payload.answer.requestId;
    case "request.delivery": return payload.receipt.requestId;
    case "request.timeout":
    case "request.cancel": return payload.requestId;
  }
}

export function commitSessionRequest(
  kernel: SessionKernel,
  sessionId: string,
  authority: { owner: string; fence: number },
  payload: SessionTransition.Payload,
  inputId: string,
  at: number,
  runtime: SessionRuntime,
  admission?: Inbox.Commit,
): Effect.Effect<RequestDecision, ExecutionError> {
  return Effect.gen(function* () {
    const row = kernel.row(sessionId);
    const requestId = requestIdentity(payload);
    const request = kernel.requestById(requestId);
    const decision = decideRequestTransition({ version: 1, sessionId, inputId, at, expectedRevision: row.revision, authority, payload }, {
      row,
      inputRecord: kernel.requestInputById(sessionId, inputId),
      invocation: kernel.actionById(requestId),
      request,
      requests: kernel.requestRows(),
      domainRevisions: request === undefined ? undefined : runtime.requestDomainRevisions?.(request),
    });
    if (decision.actions.length > 0) {
      // Reply intakes and gateway admissions are received-message chain
      // actions in the same fenced batch (the inbox table is gone). A
      // foreign-session admission (a `new_session` child's message) never
      // rides this single-session fenced batch: the child's own entity
      // commits it through `ports.inbox.commit`.
      const intake = [
        ...(decision.receive === undefined ? [] : [decision.receive]),
        ...(admission === undefined || admission.sessionId !== sessionId ? [] : [admission]),
      ].map((commit) => receivedMessageAction({ ...commit, at: commit.createdAt }));
      yield* kernel.commitRequestTransition({
        sessionId,
        ...authority,
        now: at,
        expectedRevision: row.revision,
        actions: [...decision.actions, ...intake],
        state: row.state,
        ...(decision.requestCount === undefined ? {} : { requestCount: decision.requestCount }),
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
    }
    return decision;
  });
}

/**
 * Out-of-turn request authority over a possibly-live activation (W5.2 F5):
 * adopting a fresh fence while an entity turn is running would steal that
 * activation's authority and kill its wave. This kernel view instead BORROWS
 * the running activation's owner+fence: `adoptFence` on a running session
 * records the live pair (and the borrowing caller) without touching the row,
 * `row()` reports the borrowing caller as `leaseOwner` so the pure request
 * decision (`ownsRequestRevision`) runs under the true live authority, and the
 * commit lands under the live owner+fence (same process: it lands between the
 * turn's awaits). Fence and revision are never masked — a rotated fence or a
 * moved revision still refuses — and only the caller that adopted through this
 * view gains the borrow; any other owner keeps being rejected. An idle session
 * falls back to a real adoption, the documented out-of-turn takeover.
 */
export function requestAuthorityKernel(base: SessionKernel, sessionId: string): SessionKernel {
  const holder: {
    borrowed: { readonly owner: string; readonly fence: number } | undefined;
    caller: string | undefined;
  } = { borrowed: undefined, caller: undefined };
  return {
    ...base,
    row: (id: string) => {
      const row = base.row(id);
      return holder.borrowed !== undefined && holder.caller !== undefined && id === sessionId
        ? { ...row, leaseOwner: holder.caller }
        : row;
    },
    adoptFence: (input) =>
      Effect.suspend(() => {
        const row = base.row(sessionId);
        if (input.sessionId === sessionId && row.state === "running" && row.leaseOwner !== null) {
          holder.borrowed = { owner: row.leaseOwner, fence: row.leaseFence };
          holder.caller = input.owner;
          return Effect.succeed({ ok: true as const, fence: row.leaseFence });
        }
        return base.adoptFence(input);
      }),
    commitRequestTransition: (input) =>
      base.commitRequestTransition(
        holder.borrowed === undefined
          ? input
          : { ...input, owner: holder.borrowed.owner, fence: holder.borrowed.fence },
      ),
  };
}
