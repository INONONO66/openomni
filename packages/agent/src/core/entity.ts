
import * as SessionHandleStore from "./store/fence";
import { CommitRefused, FenceRefused, SessionNotFound, type LedgerError } from "./store/errors";
import { Inbox as InboxSchema, PlainValueSchema, SessionTransition, type Inbox } from "@openomni/protocol";
import { Cause, Context, Effect, Exit, Option, Schema, type Scope, Semaphore } from "effect";
import { Entity } from "effect/cluster";
import { LeaseLost, SessionAdmissionRefused, type SessionError } from "./failure";
import { createSessionAdmission, decideSessionAdmission } from "./mailbox";
import { type SessionAdmissionSnapshot, type SessionEntityAuthority, type SessionEntityPorts, type SessionEntityTimerContext, type SessionTimerOutcome, type SessionControllerState, type ResolvedSessionRuntime, type SessionRunner, type SessionRunnerResult, createSessionTurn } from "./run";
import { deliveryActions, pendingBacklog, receivedMessageAction } from "./commit";
import { createRawSlots } from "./gate/decide";
import { decideRequestTransition } from "./request";
import { type AlarmOccurrence, type AlarmReceipt, AlarmRpc, DeadlineAlarmBody, DeliverBody, type DeliverReceipt, DeliverRefused, DeliverRpc, type ReadPage, ReadRpc, ResolveRefused, ResolveRpc, RetryAlarmBody, WatchFiredAlarmBody, WatchTimeoutAlarmBody } from "./messages";
import { alarmAction } from "./alarm";
import { renderReadModel } from "./read";

// ─── from cluster/kernel-registry.ts (#1247) ───
/**
 * The handle-scoped kernel as a declaration-nameable interface: the ledger
 * alias is a `ReturnType` projection whose parameter types stay private to the
 * ledger, so exported types here must reference it through this name.
 *
 * NOTE (W5.2 #1197 plan §3): the `SessionKernelService` Context tag over this
 * shape lands together with its first production reader (the handle plane,
 * wave 3) - the boundary law refuses tags nothing reads (R9), and every
 * wave-2 consumer receives the kernel explicitly from the entity activation.
 */
export interface SessionKernel extends SessionHandleStore.SessionKernel {}

// ─── from cluster/session-entity.ts (#1247) ───
/** Store-handle types by position on the public kernel factory (the ledger index re-export lands with wave 3). */
type SessionStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[0];
type CatalogStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[1];

/** What one runner process provides to every Session activation. */
export interface SessionEntityEnv {
  /** Stable writer identity this runner stamps into `lease_owner` (audit only; the fence authorizes). */
  readonly owner: string;
  readonly clock: () => number;
  readonly catalog: CatalogStoreHandle;
  readonly openSession: (sessionId: string) => SessionStoreHandle;
  readonly ports: SessionEntityPorts;
}

export class SessionEntityContext extends Context.Service<SessionEntityContext, SessionEntityEnv>()(
  "@openomni/agent/cluster/SessionEntityContext",
) {}

export const SessionEntity = Entity.make("Session", [DeliverRpc, ResolveRpc, AlarmRpc, ReadRpc]);

interface ActivationHandle {
  readonly env: SessionEntityEnv;
  readonly kernel: SessionKernel;
  readonly authority: SessionEntityAuthority;
  /** The activation's scope: detached turn remainders fork here. */
  readonly scope: Scope.Scope;
  /** Serializes admission decisions between the mailbox and a detached turn's continuation. */
  readonly gate: Semaphore.Semaphore;
  /** Token of the currently detached turn; set before the fork, cleared when its body exits. */
  readonly live: { current: object | undefined };
}

/**
 * Rotates the catalog fence for this activation (F5). An unindexed but
 * materialized session file self-heals into the catalog from its own row;
 * a session absent from both planes stays a typed refusal.
 */
function rotateActivationFence(env: SessionEntityEnv, kernel: SessionKernel, sessionId: string): number {
  try {
    return env.catalog.rotateFence(sessionId);
  } catch (error) {
    if (!(error instanceof SessionNotFound)) throw error;
    const row = kernel.row(sessionId);
    env.catalog.indexSession({ id: sessionId, parentId: row.parentId, role: row.role, createdAt: env.clock() });
    return env.catalog.rotateFence(sessionId);
  }
}

/**
 * Adopts the rotated catalog fence into the session file (F5): the file CAS
 * accepts only a strictly newer fence. A file fence at or beyond the target
 * means a later activation won: this one is stale.
 */
function adoptFence(kernel: SessionKernel, authority: SessionEntityAuthority): Effect.Effect<void, LedgerError> {
  const { sessionId, owner, fence } = authority;
  return Effect.suspend(() => {
    const current = kernel.row(sessionId);
    if (current.fence === fence && current.fenceOwner === owner) return Effect.void;
    if (current.fence >= fence)
      return Effect.fail(new FenceRefused({
        sessionId,
        reason: "stale",
        holder: current.fenceOwner,
        fence: current.fence,
        expiresAt: null,
      }));
    return kernel.adoptFence({ sessionId, owner, fence }).pipe(Effect.asVoid);
  });
}

/** Re-read the session row after one competing writer wins the revision CAS. */
function retryRevision<A, E extends LedgerError>(attempt: () => Effect.Effect<A, E>): Effect.Effect<A, E> {
  return attempt().pipe(
    Effect.catchIf(
      (error) => error instanceof CommitRefused && error.reason === "revision",
      () => attempt(),
    ),
  );
}

/** Idempotent receive (F4): a redelivered envelope resolves to its existing chain action. */
function appendReceived(
  handle: ActivationHandle,
  kind: Inbox.Kind,
  message: { readonly messageId: string; readonly content: string; readonly origin: string },
  delivery?: "steer" | "followUp",
): Effect.Effect<{ readonly ordinal: number; readonly actionHash: string; readonly deduped: boolean }, LedgerError> {
  return retryRevision(() => Effect.gen(function* () {
    const { kernel, authority, env } = handle;
    const existing = kernel.actionById(message.messageId);
    if (existing !== undefined)
      return { ordinal: existing.ordinal, actionHash: existing.actionHash, deduped: true };
    const row = kernel.row(authority.sessionId);
    const now = env.clock();
    const action = receivedMessageAction({
      id: message.messageId,
      sessionId: authority.sessionId,
      kind,
      content: message.content,
      origin: { encodingVersion: 1, value: PlainValueSchema.parse(JSON.parse(message.origin)) },
      parentActionId: null,
      at: now,
      ...(delivery === undefined ? {} : { delivery }),
    });
    const committed = yield* kernel.commit({
      sessionId: authority.sessionId,
      owner: authority.owner,
      fence: authority.fence,
      now,
      expectedRevision: row.revision,
      actions: [action],
      state: row.state,
    });
    const receipt = committed.receipts[0];
    if (receipt === undefined)
      return yield* Effect.die(new Error(`commit returned no receipt: ${message.messageId}`));
    return { ordinal: receipt.action.ordinal, actionHash: receipt.action.actionHash, deduped: false };
  }));
}

function admissionSnapshot(handle: ActivationHandle): SessionAdmissionSnapshot {
  const { kernel, authority } = handle;
  const row = kernel.row(authority.sessionId);
  const pending = pendingBacklog(kernel, authority.sessionId);
  const open = kernel.latestOpenTurn(authority.sessionId);
  const terminal = kernel.latestTurnTerminal(authority.sessionId);
  return { row, pending, ...(open === undefined ? {} : { open }), ...(terminal === undefined ? {} : { terminal }) };
}

/** Commits `<id>:delivery` no-op records so consumed interrupts/resumes leave the fold. */
function consumePending(handle: ActivationHandle, items: readonly Inbox.Row[]): Effect.Effect<void, LedgerError> {
  const { kernel, authority, env } = handle;
  const row = kernel.row(authority.sessionId);
  const parentId = kernel.latestAction(authority.sessionId)?.id ?? null;
  return kernel
    .commit({
      sessionId: authority.sessionId,
      owner: authority.owner,
      fence: authority.fence,
      now: env.clock(),
      expectedRevision: row.revision,
      actions: deliveryActions(items, { kind: "inbox" }, "before_llm", parentId),
      state: row.state,
    })
    .pipe(Effect.asVoid);
}

/**
 * Detached turn remainder (W5.2 S4): the port hands back the post-boundary
 * body; it forks under the activation scope so the delivering RPC acks at
 * the durable boundary. The continuation re-enters the drain when the turn
 * ends, picking up backlog that arrived after the turn's last boundary.
 */
function detachTurn(handle: ActivationHandle, body: Effect.Effect<void, SessionError>): Effect.Effect<void, SessionError> {
  return Effect.gen(function* () {
    const token = {};
    handle.live.current = token;
    yield* Effect.forkIn(
      body.pipe(
        Effect.ensuring(Effect.sync(() => {
          if (handle.live.current === token) handle.live.current = undefined;
        })),
        // A detached turn's failure has no awaiting RPC to surface through;
        // log it loud (a stale fence here means another authority took the
        // session over — the chain recovers on the next activation).
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError(`detached session turn failed: ${handle.authority.sessionId}`, cause),
        ),
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
            if (
              error instanceof LeaseLost ||
              (error instanceof FenceRefused && error.reason === "stale") ||
              (error instanceof CommitRefused && error.reason === "fence")
            ) return Effect.void;
          }
          return Effect.suspend(() => drain(handle));
        }),
        Effect.orDie,
      ),
      handle.scope,
    );
  });
}

/** What one backlog drain resolved to; `refused` carries the typed refusal fact (issue #1245). */
export type SessionDrainOutcome =
  | { readonly kind: "stop" }
  | { readonly kind: "refused"; readonly refusal: SessionAdmissionRefused }
  | { readonly kind: "turn" };

/**
 * Backlog drain (F4): consume-decisions are folded here; the first admitted
 * turn decision is handed to the composition-owned turn port, which reaches
 * its own durable boundary before the caller's ack; the remainder of the
 * turn runs detached (see `detachTurn`). While a detached turn is live the
 * drain is a no-op — the turn's own boundaries consume fresh backlog and
 * its continuation re-drains at the end.
 */
function drain(handle: ActivationHandle): Effect.Effect<SessionDrainOutcome, LedgerError | SessionError> {
  const { authority, kernel, env } = handle;
  const detach = (body: Effect.Effect<void, SessionError>) => detachTurn(handle, body);
  return handle.gate.withPermits(1)(Effect.gen(function* () {
    // #1253 turn end consumption: after a turn seals, the loop re-decides so a
    // pending `followUp` backlog starts its follow-up turn before the ack.
    let ranTurn = false;
    for (;;) {
      if (handle.live.current !== undefined) return { kind: "turn" as const };
      const snapshot = admissionSnapshot(handle);
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
          return ranTurn ? { kind: "turn" as const } : { kind: "stop" as const };
        case "refused": {
          const refusal = new SessionAdmissionRefused(authority.sessionId);
          yield* Effect.logWarning(refusal.message);
          return { kind: "refused" as const, refusal };
        }
        case "consume":
          yield* consumePending(handle, decision.items);
          continue;
        case "start":
          yield* env.ports.runTurn({ authority, kernel, decision: { kind: "start" }, snapshot, detach });
          ranTurn = true;
          continue;
        default:
          yield* env.ports.runTurn({ authority, kernel, decision, snapshot, detach });
          ranTurn = true;
          continue;
      }
    }
  }));
}

/** The core input registration table (#1253): `action` arrives with its capability. */
const CORE_INPUT_REGISTRATIONS: readonly string[] = Object.freeze(["prompt", "signal"]);

const decodeDeliverBody = Schema.decodeUnknownSync(DeliverBody);
const decodeRetryBody = Schema.decodeUnknownSync(RetryAlarmBody);
const decodeDeadlineBody = Schema.decodeUnknownSync(DeadlineAlarmBody);
const decodeWatchFiredBody = Schema.decodeUnknownSync(WatchFiredAlarmBody);
const decodeWatchTimeoutBody = Schema.decodeUnknownSync(WatchTimeoutAlarmBody);

/**
 * `deliver` (#1253): the one input door. The kind is checked against the
 * activation's input registration table, a replayed `idempotencyKey` resolves
 * to the existing seq as success with zero new facts, and a refused admission
 * is a typed rejection (`unknown_kind | missing_key | closed | denied`), never
 * a success ack. An admitted input is appended as its own journal row and the
 * loop wakes.
 */
function deliver(
  handle: ActivationHandle,
  payload: {
    readonly kind: string;
    readonly body: string;
    readonly source: string;
    readonly idempotencyKey: string;
  },
): Effect.Effect<DeliverReceipt, DeliverRefused> {
  const { kernel, authority, env } = handle;
  return Effect.gen(function* () {
    if (payload.idempotencyKey.trim().length === 0)
      return yield* new DeliverRefused({ code: "missing_key" });
    const registered = env.ports.inputRegistrations ?? CORE_INPUT_REGISTRATIONS;
    if (!registered.includes(payload.kind))
      return yield* new DeliverRefused({ code: "unknown_kind" });
    // Unguarded by construction: every activation already read this row
    // (rotateActivationFence / adoptFence) and no API deletes one, so a
    // session absent from both planes never reaches this handler — it dies at
    // activation (pinned by rpc-surface "absent from both planes"). `closed`
    // stays a reserved refusal code for the wire contract.
    const row = kernel.row(authority.sessionId);
    const body = decodeDeliverBody(JSON.parse(payload.body));
    const inboxKind: Inbox.Kind =
      payload.kind === "prompt"
        ? "prompt"
        : payload.kind === "action"
          ? "action"
          : (body.control ??
            (yield* Effect.die(new Error("signal delivery without a control op"))));
    const existing = kernel.actionById(payload.idempotencyKey);
    if (existing !== undefined) return { seq: existing.ordinal, existed: true };
    const candidate = InboxSchema.Row.parse({
      id: payload.idempotencyKey,
      sessionId: authority.sessionId,
      kind: inboxKind,
      content: body.content,
      origin: { encodingVersion: 1, value: PlainValueSchema.parse(JSON.parse(payload.source)) },
      ...(body.delivery === undefined ? {} : { delivery: body.delivery }),
      status: "pending",
      consumedBy: null,
      consumedAt: null,
      createdAt: env.clock(),
      ordinal: pendingBacklog(kernel, authority.sessionId).length + 1,
    });
    const snapshot = admissionSnapshot(handle);
    const decision = decideSessionAdmission({
      ...snapshot,
      pending: [...snapshot.pending, candidate],
      row,
    });
    if (decision.kind === "refused")
      return yield* new DeliverRefused({
        code: decision.reason === "unknown_kind" ? "unknown_kind" : "denied",
      });
    const receipt = yield* appendReceived(
      handle,
      inboxKind,
      {
        messageId: payload.idempotencyKey,
        content: body.content,
        origin: payload.source,
      },
      body.delivery,
    ).pipe(Effect.orDie);
    yield* drain(handle).pipe(Effect.orDie);
    return { seq: receipt.ordinal, existed: receipt.deduped };
  });
}

/**
 * `resolve` (#1253): settle one open request. A missing request is
 * `unknown_request`, a settled one `already_resolved` — both typed, both with
 * zero new journal facts. A redelivered `inputId` replays through the pure
 * request authority's dedup instead of refusing.
 */
function resolveCommand(
  handle: ActivationHandle,
  payload: {
    readonly requestId: string;
    readonly outcome: "resolved" | "cancelled";
    readonly payload: string;
    readonly inputId: string;
  },
): Effect.Effect<{ readonly resolution: string }, ResolveRefused> {
  const { kernel, authority } = handle;
  return Effect.gen(function* () {
    const replayed = kernel.requestInputById(authority.sessionId, payload.inputId) !== undefined;
    if (!replayed) {
      const request = kernel.requestById(payload.requestId);
      if (request === undefined) return yield* new ResolveRefused({ code: "unknown_request" });
      if (request.state !== "open") return yield* new ResolveRefused({ code: "already_resolved" });
    }
    const transition: SessionTransition.Payload =
      payload.outcome === "resolved"
        ? SessionTransition.Payload.parse(JSON.parse(payload.payload))
        : {
            kind: "request.cancel",
            requestId: payload.requestId,
            principal: SessionTransition.Principal.parse(JSON.parse(payload.payload)),
          };
    return yield* requestCommand(handle, payload.requestId, payload.inputId, transition);
  });
}

/**
 * `alarm` (#1253): one occurrence through the chain-guarded fold. An applied
 * occurrence wakes the loop; a superseded one is recorded as an
 * `alarm{fired, outcome: stale}` fact — never a rejection — and the loop
 * stays asleep. #1254 owns the purpose set and re-registration.
 */
function alarmOccurrence(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
): Effect.Effect<AlarmReceipt> {
  const { timers } = handle.env.ports;
  const context: SessionEntityTimerContext = {
    authority: handle.authority,
    kernel: handle.kernel,
    now: handle.env.clock(),
  };
  const dispatch = (): Effect.Effect<SessionTimerOutcome, SessionError> => {
    switch (occurrence.purpose) {
      case "retry": {
        const body = decodeRetryBody(JSON.parse(occurrence.body));
        return timers.retryScheduled(context, {
          alarmId: body.alarmId,
          attempt: body.attempt,
          notBefore: occurrence.fireAt,
        });
      }
      case "deadline": {
        const body = decodeDeadlineBody(JSON.parse(occurrence.body));
        return timers.deadline(context, {
          requestId: body.requestId,
          deadlineAt: occurrence.fireAt,
        });
      }
      case "watch.fired": {
        const body = decodeWatchFiredBody(JSON.parse(occurrence.body));
        return timers.watchFired(context, body);
      }
      case "watch.timeout": {
        const body = decodeWatchTimeoutBody(JSON.parse(occurrence.body));
        return timers.watchTimeout(context, {
          watchId: body.watchId,
          epoch: body.epoch,
          fireAt: occurrence.fireAt,
        });
      }
    }
  };
  return Effect.gen(function* () {
    const outcome = yield* dispatch();
    if (outcome === "applied") {
      yield* drain(handle);
      return { outcome: "delivered" as const };
    }
    yield* appendStaleAlarm(handle, occurrence);
    return { outcome: "stale" as const };
  }).pipe(Effect.orDie);
}

/**
 * `read` (#1253): one model page from the journal fold. A pure, bounded
 * projection over committed history — it appends nothing and never wakes the
 * loop. Pagination follows the chain's own revision cursor.
 */
function readProjection(
  handle: ActivationHandle,
  payload: { readonly model: Parameters<typeof renderReadModel>[0]; readonly cursor: number },
): Effect.Effect<ReadPage> {
  const { kernel, authority } = handle;
  return Effect.sync(() => {
    const page = kernel.historyPage(authority.sessionId, { afterRevision: payload.cursor, limit: 256 });
    return {
      body: JSON.stringify(renderReadModel(payload.model, page.actions)),
      nextCursor: page.nextRevision,
    };
  });
}

/** The recorded stale-occurrence fact; idempotent on `<occurrenceId>:stale`. */
function appendStaleAlarm(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
): Effect.Effect<void, LedgerError> {
  const { kernel, authority, env } = handle;
  const id = `${occurrence.occurrenceId}:stale`;
  return retryRevision(() =>
    Effect.suspend(() => {
      if (kernel.actionById(id) !== undefined) return Effect.void;
      const row = kernel.row(authority.sessionId);
      const now = env.clock();
      return kernel
        .commit({
          sessionId: authority.sessionId,
          owner: authority.owner,
          fence: authority.fence,
          now,
          expectedRevision: row.revision,
          actions: [
            alarmAction({
              id,
              parentId: kernel.latestAction(authority.sessionId)?.id ?? null,
              sessionId: authority.sessionId,
              intent: {
                op: "fired",
                outcome: "stale",
                purpose: occurrence.purpose,
                occurrenceId: occurrence.occurrenceId,
              },
              effect: { op: "fired", outcome: "stale", occurrenceId: occurrence.occurrenceId },
              ts: now,
            }),
          ],
          state: row.state,
        })
        .pipe(Effect.asVoid);
    }),
  );
}


/**
 * One request command through the pure request authority (C3). The command's
 * `inputId` is the durable idempotency key; a reply intake from the decision
 * is committed as a received-message chain action in the same batch.
 */
function requestSnapshot(
  handle: ActivationHandle,
  requestId: string,
  inputId: string,
  row: ReturnType<SessionKernel["row"]>,
): Parameters<typeof decideRequestTransition>[1] {
  const { kernel, authority, env } = handle;
  const request = kernel.requestById(requestId);
  return {
    row,
    ...(kernel.requestInputById(authority.sessionId, inputId) === undefined
      ? {}
      : { inputRecord: kernel.requestInputById(authority.sessionId, inputId) }),
    ...(kernel.actionById(requestId) === undefined ? {} : { invocation: kernel.actionById(requestId) }),
    ...(request === undefined ? {} : { request }),
    requests: kernel.requestRows(authority.sessionId),
    ...(request === undefined || env.ports.requestDomainRevisions === undefined
      ? {}
      : { domainRevisions: env.ports.requestDomainRevisions(request) }),
  };
}

function requestCommand(
  handle: ActivationHandle,
  requestId: string,
  inputId: string,
  payload: SessionTransition.Payload,
): Effect.Effect<{ readonly resolution: string }> {
  const attempt = () => Effect.gen(function* () {
    const { kernel, authority, env } = handle;
    const row = kernel.row(authority.sessionId);
    const decision = decideRequestTransition(
      {
        version: 1,
        sessionId: authority.sessionId,
        inputId,
        at: env.clock(),
        expectedRevision: row.revision,
        authority: { owner: authority.owner, fence: authority.fence },
        payload,
      },
      requestSnapshot(handle, requestId, inputId, row),
    );
    const intake =
      decision.receive === undefined
        ? []
        : [receivedMessageAction({ ...decision.receive, at: decision.receive.createdAt })];
    if (decision.actions.length > 0) {
      yield* kernel.commit({
        sessionId: authority.sessionId,
        owner: authority.owner,
        fence: authority.fence,
        now: env.clock(),
        expectedRevision: row.revision,
        actions: [...decision.actions, ...intake],
        state: row.state,
        ...(decision.requestCount === undefined ? {} : { requestCount: decision.requestCount }),
      });
    }
    return { resolution: decision.resolution, committed: decision.actions.length > 0 };
  });
  return Effect.gen(function* () {
    const result = yield* retryRevision(attempt);
    if (result.committed) yield* drain(handle);
    return { resolution: result.resolution };
  }).pipe(Effect.orDie);
}

/**
 * One activation per session (plan §3): open the per-session store, rotate the
 * catalog fence, adopt it into the file lease, publish the kernel handle, and
 * drain the backlog before the mailbox opens. A refused rotation means a later
 * activation exists; dying hands the mailbox back to the cluster.
 */
export const SessionEntityLive = SessionEntity.toLayer(
  Effect.gen(function* () {
    const env = yield* SessionEntityContext;
    const address = yield* Entity.CurrentAddress;
    const sessionId = address.entityId;
    const store = env.openSession(sessionId);
    yield* Effect.addFinalizer(() => Effect.sync(() => store.close()));
    const kernel = SessionHandleStore.createSessionKernel(store, env.catalog);
    const authority: SessionEntityAuthority = {
      sessionId,
      owner: env.owner,
      fence: rotateActivationFence(env, kernel, sessionId),
    };
    yield* adoptFence(kernel, authority).pipe(Effect.orDie);
    const scope = yield* Effect.scope;
    const gate = yield* Semaphore.make(1);
    const handle: ActivationHandle = { env, kernel, authority, scope, gate, live: { current: undefined } };
    yield* drain(handle).pipe(Effect.orDie);
    return {
      Deliver: (envelope: Entity.Request<typeof DeliverRpc>) => deliver(handle, envelope.payload),
      Resolve: (envelope: Entity.Request<typeof ResolveRpc>) => resolveCommand(handle, envelope.payload),
      Alarm: (envelope: Entity.Request<typeof AlarmRpc>) => alarmOccurrence(handle, envelope.payload),
      Read: (envelope: Entity.Request<typeof ReadRpc>) => readProjection(handle, envelope.payload),
    };
  }),
);

/**
 * The real turn port for the Session entity (W5.2 F6): one admitted decision
 * runs through the same admission/turn machinery the in-process controller
 * uses, against the activation's kernel and pinned fence. The entity already
 * owns receipt, dedupe and authority; this port only reaches the durable turn
 * boundary and never re-adopts the fence. The admission paths commit that
 * boundary (deliveries + turn envelope, state `running`) before invoking the
 * turn runner, so the runner handed to the admission detaches its body via
 * `input.detach` (W5.2 S4): the delivering RPC acks at the boundary and the
 * model/tool remainder runs under the activation scope instead.
 */
export function createSessionEntityRunTurn(
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  scope: Scope.Scope,
): SessionEntityPorts["runTurn"] {
  return (input) => Effect.gen(function* () {
    const { kernel, authority, decision } = input;
    const state: SessionControllerState = {
      active: undefined, controller: undefined, fence: authority.fence,
      closed: false, terminalFrozen: false, released: false, successor: undefined,
      retainedRunner: undefined,
      rawSlots: createRawSlots(), activeApprovals: undefined,
    };
    const { runTurn, seal } = createSessionTurn(kernel, authority.sessionId, runner, runtime, state, authority.owner, runtime.clock, runtime.entropy, scope, {
      createExecutionLedger: (...args) => admission.createExecutionLedger(...args),
      evaluatePromptPolicies: (...args) => admission.evaluatePromptPolicies(...args),
      consumePolicyBlockedInbox: (...args) => admission.consumePolicyBlockedInbox(...args),
      hibernate: () => Effect.void,
    });
    // The synthetic result never persists: seals ride the detached body, and
    // every entity admission path returns the runner result to a void sink.
    const detachedRunTurn: typeof runTurn = (turnInput) =>
      input.detach(runTurn(turnInput).pipe(Effect.asVoid)).pipe(
        Effect.as<SessionRunnerResult>({ kind: "waiting", reason: "live_wait", alarmIds: [], text: "" }),
      );
    const admission = createSessionAdmission(kernel, authority.sessionId, runtime, state, authority.owner, runtime.clock, runtime.entropy, { awaitRetainedRunner: () => Effect.void, runTurn: detachedRunTurn, seal });
    switch (decision.kind) {
      case "start": return void (yield* admission.startTurn());
      case "recover": return void (yield* admission.resumeTurn(decision.open));
      case "resume": return void (yield* admission.resumeInterrupted(decision.item));
    }
  });
}
