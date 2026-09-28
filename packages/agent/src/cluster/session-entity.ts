import { LeaseRefused, SessionHandleStore, SessionNotFound, type LedgerError } from "@openomni/ledger";
import {
  Inbox,
  PlainValueSchema,
  SessionTransition,
  type LedgerAction,
} from "@openomni/protocol";
import { Context, Effect } from "effect";
import { Entity } from "effect/cluster";
import { z } from "zod";
import type { SessionError } from "../errors";
import { decideSessionAdmission } from "../session-admission";
import type {
  SessionAdmissionSnapshot,
  SessionEntityAuthority,
  SessionEntityPorts,
  SessionEntityTimerContext,
  SessionTimerOutcome,
} from "../session-contract";
import { deliveryActions } from "../session-record";
import { decideRequestTransition } from "../session-request";
import { sessionKernels, type SessionKernel } from "./kernel-registry";
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
export type SessionStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[0];
export type CatalogStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[1];

/**
 * 2100-01-01T00:00:00Z. Entity activations have no liveness heartbeat - the
 * catalog fence CAS is the takeover authority (F5) - so the adopted file lease
 * carries a far-future expiry to neutralize the legacy TTL predicate until
 * wave 3 deletes it. Each takeover advances at least 1ms past the previous
 * expiry so the takeover instant satisfies the inclusive expiry rule.
 */
const ROTATION_LEASE_EXPIRES_AT = 4_102_444_800_000;

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

/** The chain effect one received message commits; the pending fold reads it back. */
const ReceivedEffect = z.object({ inboxKind: Inbox.Kind, content: z.string() });
const DeliverIntent = z.object({ inboxId: z.string() });

interface ActivationHandle {
  readonly env: SessionEntityEnv;
  readonly kernel: SessionKernel;
  readonly authority: SessionEntityAuthority;
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
 * Adopts the rotated catalog fence into the session file's lease CAS, walking
 * the single-increment CAS up to `fence`. The catalog CAS already decided
 * this activation wins, so a still-unexpired lease held by the previous
 * activation is taken over by advancing `now` to its expiry. A file fence at
 * or beyond the target means a later activation won: this one is stale.
 */
function adoptFence(kernel: SessionKernel, authority: SessionEntityAuthority, now: number): Effect.Effect<void, LedgerError> {
  const { sessionId, owner, fence } = authority;
  return Effect.gen(function* () {
    for (;;) {
      const current = kernel.row(sessionId);
      if (current.leaseFence === fence && current.leaseOwner === owner) return;
      if (current.leaseFence >= fence) {
        return yield* new LeaseRefused({
          sessionId,
          reason: "stale",
          holder: current.leaseOwner,
          fence: current.leaseFence,
          expiresAt: current.leaseExpiresAt,
        });
      }
      const takeoverNow = Math.max(now, current.leaseExpiresAt ?? now);
      yield* kernel
        .acquireLease({
          sessionId,
          owner,
          expectedFence: current.leaseFence,
          now: takeoverNow,
          expiresAt: Math.max(ROTATION_LEASE_EXPIRES_AT, takeoverNow + 1),
        })
        // A lost single-increment race: re-read and re-decide from the fresh row.
        .pipe(Effect.catchTag("LeaseRefused", () => Effect.void));
    }
  });
}

/** The durable chain action for one received message (the inbox table is gone; the chain is the inbox). */
function receivedMessageAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: Inbox.Kind;
  readonly content: string;
  readonly origin: Inbox.Origin;
  readonly parentActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentActionId,
    sessionId: input.sessionId,
    kind: "prompt",
    intent: input.origin,
    effect: { encodingVersion: 1, value: { inboxKind: input.kind, content: input.content } },
    irreversible: true,
    ts: input.at,
  };
}

/** Idempotent receive (F4): a redelivered envelope resolves to its existing chain action. */
function appendReceived(
  handle: ActivationHandle,
  kind: Inbox.Kind,
  message: { readonly messageId: string; readonly content: string; readonly origin: string },
): Effect.Effect<ChainAppendReceipt, LedgerError> {
  const { kernel, authority, env } = handle;
  const existing = kernel.actionById(message.messageId);
  if (existing !== undefined)
    return Effect.succeed({ ordinal: existing.ordinal, actionHash: existing.actionHash, deduped: true });
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
  return kernel
    .commit({
      sessionId: authority.sessionId,
      owner: authority.owner,
      fence: authority.fence,
      now,
      expectedRevision: row.revision,
      actions: [action],
      consumeInboxIds: [],
      state: row.state,
      releaseLease: false,
    })
    .pipe(
      Effect.map((committed) => {
        const receipt = committed.receipts[0];
        if (receipt === undefined) throw new Error(`commit returned no receipt: ${message.messageId}`);
        return { ordinal: receipt.action.ordinal, actionHash: receipt.action.actionHash, deduped: false };
      }),
    );
}

/**
 * Pending admission over a per-session file is a chain fold (plan F1): every
 * received-message action without its `<id>:delivery` record is pending.
 */
function pendingBacklog(kernel: SessionKernel, sessionId: string): Inbox.Row[] {
  const received: { readonly action: LedgerAction.Node; readonly kind: Inbox.Kind; readonly content: string }[] = [];
  const delivered = new Set<string>();
  let afterRevision = 0;
  for (;;) {
    const page = kernel.historyPage(sessionId, { afterRevision, limit: 256 });
    for (const action of page.actions) {
      if (action.kind === "prompt") {
        const effect = ReceivedEffect.safeParse(action.effect.value);
        if (effect.success) received.push({ action, kind: effect.data.inboxKind, content: effect.data.content });
      } else if (action.kind === "inbox.deliver") {
        const intent = DeliverIntent.safeParse(action.intent.value);
        if (intent.success) delivered.add(intent.data.inboxId);
      }
    }
    if (page.nextRevision === null) break;
    afterRevision = page.nextRevision;
  }
  return received
    .filter((entry) => !delivered.has(entry.action.id))
    .map((entry, index) =>
      Inbox.Row.parse({
        id: entry.action.id,
        sessionId,
        kind: entry.kind,
        content: entry.content,
        origin: entry.action.intent,
        status: "pending",
        consumedBy: null,
        consumedAt: null,
        createdAt: entry.action.ts,
        ordinal: index + 1,
      }),
    );
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
      actions: deliveryActions(items, "noop", "before_llm", parentId),
      consumeInboxIds: [],
      state: row.state,
      releaseLease: false,
    })
    .pipe(Effect.asVoid);
}

/**
 * Backlog drain (F4): consume-decisions are folded here; the first admitted
 * turn decision is handed to the composition-owned turn port, which reaches
 * its own durable boundary before the caller's ack.
 */
function drain(handle: ActivationHandle): Effect.Effect<void, LedgerError | SessionError> {
  const { authority, kernel, env } = handle;
  return Effect.gen(function* () {
    for (;;) {
      const snapshot = admissionSnapshot(handle);
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
        case "refused":
          return;
        case "consume":
          yield* consumePending(handle, decision.items);
          continue;
        case "start":
          return yield* env.ports.runTurn({ authority, kernel, decision: { kind: "start" }, snapshot });
        default:
          return yield* env.ports.runTurn({ authority, kernel, decision, snapshot });
      }
    }
  });
}

function receive(
  handle: ActivationHandle,
  kind: Inbox.Kind,
  message: { readonly messageId: string; readonly content: string; readonly origin: string },
): Effect.Effect<ChainAppendReceipt> {
  return Effect.gen(function* () {
    const receipt = yield* appendReceived(handle, kind, message);
    yield* drain(handle);
    return receipt;
  }).pipe(Effect.orDie);
}

/**
 * One request command through the pure request authority (C3). The command's
 * `inputId` is the durable idempotency key; a reply intake from the decision
 * is committed as a received-message chain action in the same batch.
 */
function requestCommand(
  handle: ActivationHandle,
  requestId: string,
  inputId: string,
  payload: SessionTransition.Payload,
): Effect.Effect<{ readonly resolution: string }> {
  return Effect.gen(function* () {
    const { kernel, authority, env } = handle;
    const row = kernel.row(authority.sessionId);
    const request = kernel.requestById(requestId);
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
      {
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
      },
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
        consumeInboxIds: [],
        state: row.state,
        releaseLease: false,
        ...(decision.requestCount === undefined ? {} : { requestCount: decision.requestCount }),
      });
      yield* drain(handle);
    }
    return { resolution: decision.resolution };
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
    yield* adoptFence(kernel, authority, env.clock()).pipe(Effect.orDie);
    const unregister = sessionKernels.register(sessionId, kernel);
    yield* Effect.addFinalizer(() => Effect.sync(unregister));
    const handle: ActivationHandle = { env, kernel, authority };
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
