import { Effect } from "effect";
import { CommitFailed, type ExecutionError } from "./errors";
import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  type Inbox,
  type LedgerAction,
  type SessionGeneration,
  type SessionTransition,
  type PlainValue,
} from "@openomni/protocol";
import type { SessionRuntime } from "./session-contract";
import { getSessionHandle } from "./session-handle";
import { requestBindingDigest } from "./session-request";
import { commitSessionRequest } from "./session-admission";

export interface SessionRequestPort {
  list(): readonly SessionTransition.Request[];
  timeout(requestId: string, at: number): Effect.Effect<void, ExecutionError>;
  open(input: {
    requestId: string;
    sessionId: string;
    expectedResponders: readonly string[];
    correlation: SessionTransition.Correlation;
    allowedActions: readonly SessionTransition.AllowedAction[];
    resolution: "first" | "quorum" | "all";
    threshold: number;
    deadline: number;
    at: number;
    admission?: Inbox.Commit;
  }): Effect.Effect<SessionTransition.Request, ExecutionError>;
  answer(input: SessionTransition.Answer): Effect.Effect<SessionTransition.Resolution, ExecutionError>;
  receipt(input: SessionTransition.DeliveryReceipt): Effect.Effect<SessionTransition.Request, ExecutionError>;
}

function requestGeneration(
  actions: readonly LedgerAction.Node[],
  turnId: string | null,
): SessionGeneration.Snapshot {
  if (turnId === null) return SessionHandleStore.latestGeneration(actions);
  const turn = SessionHandleStore.turnIntent(actions.find((action) => action.id === turnId));
  const generation =
    turn === undefined
      ? undefined
      : SessionHandleStore.generationByNumber(actions, turn.toolsGeneration);
  if (
    turn === undefined ||
    generation === undefined ||
    generation.toolsHash !== turn.toolsHash ||
    generation.systemHash !== turn.systemHash ||
    generation.policyGeneration !== turn.policyGeneration
  ) {
    throw new Error("original request generation is unavailable");
  }
  return generation;
}

/** The gateway gets this injected kernel port, never a lifecycle store. */
export function createSessionRequests(runtime: SessionRuntime): SessionRequestPort {
  const clock = runtime.clock ?? Date.now;
  const entropy = runtime.entropy ?? (() => crypto.randomUUID());
  function transition(
    sessionId: string,
    payload: SessionTransition.Payload,
    inputId: string,
    at: number,
    admission?: Inbox.Commit,
  ) {
    return Effect.gen(function* () {
    const live = getSessionHandle(sessionId, runtime);
    if (live !== undefined) return yield* live.requests.transition(payload, inputId, at, admission);
    const owner = `${runtime.processId ?? process.pid}:request:${entropy()}`;
    const row = SessionHandleStore.row(sessionId);
    const now = clock();
    const lease = yield* SessionHandleStore.acquireLease({
      sessionId, owner, expectedFence: row.leaseFence, now, expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
    return yield* commitSessionRequest(
      sessionId, { owner, fence: lease.fence }, payload, inputId, Math.max(at, now), runtime, admission,
    ).pipe(Effect.onExit(() => Effect.suspend(() => {
      const current = SessionHandleStore.row(sessionId);
      return SessionHandleStore.commit({
        sessionId, owner, fence: lease.fence, now: clock(), expectedRevision: current.revision,
        actions: [], consumeInboxIds: [], state: current.state, releaseLease: true,
      }).pipe(Effect.orDie, Effect.asVoid);
    })));
    });
  }
  function timeout(requestId: string, at: number): Effect.Effect<void, ExecutionError> {
    return Effect.gen(function* () {
    const request = SessionHandleStore.requestById(requestId);
    if (request === undefined) throw new Error(`deadline request missing: ${requestId}`);
    const result = yield* transition(
      request.sessionId,
      { kind: "request.timeout", requestId },
      `${requestId}:deadline`,
      at,
    );
    if (
      result.actions.length > 0 &&
      result.request?.mode === "approval" &&
      result.request.state !== "open"
    )
      runtime.onRequestReady?.(request.sessionId);
    });
  }
  return {
    list: () => SessionHandleStore.requestRows(),
    timeout,
    open(input) {
      return Effect.gen(function* () {
      const actions = SessionHandleStore.tree(input.sessionId);
      const original = actions.find((action) => action.id === input.requestId);
      const intent = original?.intent.value;
      if (
        intent === null ||
        typeof intent !== "object" ||
        Array.isArray(intent) ||
        intent.value === undefined
      )
        throw new Error(`original invocation missing: ${input.requestId}`);
      const turnId = typeof intent.turnId === "string" ? intent.turnId : null;
      const generation = requestGeneration(actions, turnId);
      const value: PlainValue = intent.value;
      const request: SessionTransition.Request = {
        requestId: input.requestId,
        sessionId: input.sessionId,
        turnId,
        callId: typeof intent.callId === "string" ? intent.callId : input.requestId,
        mode: "reply",
        parsedInput: value,
        inputHash: canonicalDigest(value),
        effectHash: typeof intent.effectHash === "string" ? intent.effectHash : canonicalDigest({}),
        generation: generation.policyGeneration,
        toolsGeneration: generation.generation,
        toolsHash: generation.toolsHash,
        systemHash: generation.systemHash,
        domainRevisions: {},
        deadline: input.deadline,
        expectedResponders: [...input.expectedResponders],
        correlation: input.correlation,
        allowedActions: [...input.allowedActions],
        bindingDigest: "",
        resolution: input.resolution,
        threshold: input.threshold,
        seenReplyIds: [],
        replies: [],
        state: "open",
        outcome: null,
        createdAt: input.at,
      };
      request.bindingDigest = requestBindingDigest(request);
      const decision = yield* transition(
        input.sessionId,
        { kind: "request.open", request },
        `${input.requestId}:open`,
        input.at,
        input.admission,
      );
      if (decision.request === undefined)
        throw new Error(`request open refused: ${input.requestId}`);
      return decision.request;
      });
    },
    answer(answer) {
      return Effect.gen(function* () {
      const result = yield* transition(
        answer.sessionId,
        { kind: "request.answer", answer },
        answer.inputId,
        clock(),
      );
      if (result.receive !== undefined) runtime.onInboxCommitted?.([result.receive.sessionId]);
      if (
        result.actions.length > 0 &&
        result.request?.mode === "approval" &&
        result.request.state !== "open"
      )
        runtime.onRequestReady?.(answer.sessionId);
      return result.resolution;
      });
    },
    receipt(receipt) {
      return Effect.gen(function* () {
      const result = yield* transition(
        receipt.sessionId,
        { kind: "request.delivery", receipt },
        receipt.inputId,
        clock(),
      );
      if (result.request === undefined)
        throw new Error(`request receipt refused: ${receipt.requestId}`);
      return result.request;
      });
    },
  };
}
