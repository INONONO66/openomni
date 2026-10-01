import { CommitRefused, LeaseRefused, SessionHandleStore, SessionNotFound, type LedgerError } from "@openomni/ledger";
import {
  PlainValueSchema,
  SessionTransition,
  type Inbox,
} from "@openomni/protocol";
import { Cause, Context, Effect, Exit, Option, type Scope, Semaphore } from "effect";
import { Entity } from "effect/cluster";
import { LeaseLost, SessionAdmissionRefused, type SessionError } from "../errors";
import { decideSessionAdmission } from "../session-admission";
import type {
  SessionAdmissionSnapshot,
  SessionEntityAuthority,
  SessionEntityPorts,
  SessionEntityTimerContext,
  SessionTimerOutcome,
} from "../session-contract";
import { deliveryActions, pendingBacklog, receivedMessageAction } from "../session-record";
import { decideRequestTransition } from "../session-request";
import type { SessionKernel } from "./kernel-registry";
import {
  DeadlineRpc,
  InterruptRpc,
  PromptRpc,
  RequestCancelRpc,
  RequestResolveRpc,
  ResumeRpc,
  RetryScheduledRpc,
  WatchFiredRpc,
  WatchTimeoutRpc,
  type ChainAppendReceipt,
} from "./messages";

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

export const SessionEntity = Entity.make("Session", [
  PromptRpc,
  InterruptRpc,
  ResumeRpc,
  RequestResolveRpc,
  RequestCancelRpc,
  RetryScheduledRpc,
  DeadlineRpc,
  WatchFiredRpc,
  WatchTimeoutRpc,
]);

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
    if (current.leaseFence === fence && current.leaseOwner === owner) return Effect.void;
    if (current.leaseFence >= fence)
      return Effect.fail(new LeaseRefused({
        sessionId,
        reason: "stale",
        holder: current.leaseOwner,
        fence: current.leaseFence,
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
): Effect.Effect<Omit<ChainAppendReceipt, "admission">, LedgerError> {
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
              (error instanceof LeaseRefused && error.reason === "stale") ||
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
    for (;;) {
      if (handle.live.current !== undefined) return { kind: "turn" as const };
      const snapshot = admissionSnapshot(handle);
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
          return { kind: "stop" as const };
        case "refused": {
          const refusal = new SessionAdmissionRefused({ sessionId: authority.sessionId });
          yield* Effect.logWarning(refusal.message);
          return { kind: "refused" as const, refusal };
        }
        case "consume":
          yield* consumePending(handle, decision.items);
          continue;
        case "start":
          yield* env.ports.runTurn({ authority, kernel, decision: { kind: "start" }, snapshot, detach });
          return { kind: "turn" as const };
        default:
          yield* env.ports.runTurn({ authority, kernel, decision, snapshot, detach });
          return { kind: "turn" as const };
      }
    }
  }));
}

function receive(
  handle: ActivationHandle,
  kind: Inbox.Kind,
  message: { readonly messageId: string; readonly content: string; readonly origin: string },
): Effect.Effect<ChainAppendReceipt> {
  return Effect.gen(function* () {
    const receipt = yield* appendReceived(handle, kind, message);
    const outcome = yield* drain(handle);
    return { ...receipt, admission: outcome.kind };
  }).pipe(Effect.orDie);
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
      yield* kernel.commitRequestTransition({
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

/** Timer wakes (C2): the port owns the chain-guarded fold; `applied` wakes the drain. */
function timerWake(
  handle: ActivationHandle,
  run: (context: SessionEntityTimerContext) => Effect.Effect<SessionTimerOutcome, SessionError>,
): Effect.Effect<{ readonly outcome: SessionTimerOutcome }> {
  return Effect.gen(function* () {
    const outcome = yield* run({ authority: handle.authority, kernel: handle.kernel, now: handle.env.clock() });
    if (outcome === "applied") yield* drain(handle);
    return { outcome };
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
    const { timers } = env.ports;
    return {
      Prompt: (envelope: Entity.Request<typeof PromptRpc>) => receive(handle, "prompt", envelope.payload),
      Interrupt: (envelope: Entity.Request<typeof InterruptRpc>) => receive(handle, "interrupt", envelope.payload),
      Resume: (envelope: Entity.Request<typeof ResumeRpc>) => receive(handle, "resume", envelope.payload),
      RequestResolve: (envelope: Entity.Request<typeof RequestResolveRpc>) =>
        requestCommand(
          handle,
          envelope.payload.requestId,
          envelope.payload.inputId,
          SessionTransition.Payload.parse(JSON.parse(envelope.payload.payload)),
        ),
      RequestCancel: (envelope: Entity.Request<typeof RequestCancelRpc>) =>
        requestCommand(handle, envelope.payload.requestId, envelope.payload.inputId, {
          kind: "request.cancel",
          requestId: envelope.payload.requestId,
          principal: SessionTransition.Principal.parse(JSON.parse(envelope.payload.principal)),
        }),
      RetryScheduled: (envelope: Entity.Request<typeof RetryScheduledRpc>) =>
        timerWake(handle, (context) => timers.retryScheduled(context, envelope.payload)),
      Deadline: (envelope: Entity.Request<typeof DeadlineRpc>) =>
        timerWake(handle, (context) => timers.deadline(context, envelope.payload)),
      WatchFired: (envelope: Entity.Request<typeof WatchFiredRpc>) =>
        timerWake(handle, (context) => timers.watchFired(context, envelope.payload)),
      WatchTimeout: (envelope: Entity.Request<typeof WatchTimeoutRpc>) =>
        timerWake(handle, (context) => timers.watchTimeout(context, envelope.payload)),
    };
  }),
);
