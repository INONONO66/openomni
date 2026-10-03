import { DateTime, PrimaryKey, Schema } from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc } from "effect/rpc";

/**
 * The Session entity wire protocol (W5.2 #1197, plan D12/D13). Every RPC is
 * persisted: envelopes survive in the runner storage until the handler acks,
 * and the ack is sent only after the corresponding ledger commit, so a crash
 * between commit and ack yields redelivery, never loss (F4). Handlers dedupe
 * redelivered envelopes by durable chain identity (`messageId` for received
 * messages, `inputId` for request commands, alarm/watch keys for timers), so
 * at-least-once delivery folds to exactly-once ledger effects.
 */

/** Ack for an idempotent chain append; `deduped` marks a replayed envelope. */
export const ChainAppendReceipt = Schema.Struct({
  ordinal: Schema.Number,
  actionHash: Schema.String,
  deduped: Schema.Boolean,
  /** The post-append drain outcome: callers distinguish a refused admission from a clean stop (issue #1245). */
  admission: Schema.Literals(["stop", "refused", "turn"]),
});
export type ChainAppendReceipt = typeof ChainAppendReceipt.Type;

/** Ack for a request command; carries the pure authority's resolution token. */
const RequestReceipt = Schema.Struct({ resolution: Schema.String });

/** Timer acks distinguish applied work from a chain-guarded no-op (F2). */
const TimerReceipt = Schema.Struct({
  outcome: Schema.Literals(["applied", "noop"]),
});

/**
 * A received message (C1). `origin` is the canonical JSON of the envelope's
 * origin value; the handler parses it with the protocol schema at the
 * boundary. `messageId` is the durable chain action id (idempotency key).
 */
const receivedMessage = {
  messageId: Schema.String,
  content: Schema.String,
  origin: Schema.String,
};

export const PromptRpc = Rpc.make("Prompt", {
  payload: receivedMessage,
  success: ChainAppendReceipt,
}).annotate(ClusterSchema.Persisted, true);

export const InterruptRpc = Rpc.make("Interrupt", {
  payload: receivedMessage,
  success: ChainAppendReceipt,
}).annotate(ClusterSchema.Persisted, true);

export const ResumeRpc = Rpc.make("Resume", {
  payload: receivedMessage,
  success: ChainAppendReceipt,
}).annotate(ClusterSchema.Persisted, true);

/**
 * Request commands (C3). `payload` is the canonical JSON of a
 * `SessionTransition.Payload`; `inputId` is the durable idempotency key the
 * pure request authority dedupes on. `principal` is audit identity only.
 */
export const RequestResolveRpc = Rpc.make("RequestResolve", {
  payload: {
    requestId: Schema.String,
    inputId: Schema.String,
    payload: Schema.String,
    principal: Schema.String,
  },
  success: RequestReceipt,
}).annotate(ClusterSchema.Persisted, true);

export const RequestCancelRpc = Rpc.make("RequestCancel", {
  payload: {
    requestId: Schema.String,
    inputId: Schema.String,
    principal: Schema.String,
  },
  success: RequestReceipt,
}).annotate(ClusterSchema.Persisted, true);

/** Wake for a scheduled retry (C2); delivered no earlier than `notBefore`. */
class RetryScheduledPayload extends Schema.Class<RetryScheduledPayload>(
  "@openomni/agent/cluster/RetryScheduledPayload",
)({
  alarmId: Schema.String,
  attempt: Schema.Number,
  notBefore: Schema.Number,
}) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return DateTime.makeUnsafe(this.notBefore);
  }
}

export const RetryScheduledRpc = Rpc.make("RetryScheduled", {
  payload: RetryScheduledPayload,
  success: TimerReceipt,
}).annotate(ClusterSchema.Persisted, true);

/** Request deadline wake (C2); delivered at the request's inclusive deadline. */
class DeadlinePayload extends Schema.Class<DeadlinePayload>(
  "@openomni/agent/cluster/DeadlinePayload",
)({
  requestId: Schema.String,
  deadlineAt: Schema.Number,
}) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return DateTime.makeUnsafe(this.deadlineAt);
  }
}

export const DeadlineRpc = Rpc.make("Deadline", {
  payload: DeadlinePayload,
  success: TimerReceipt,
}).annotate(ClusterSchema.Persisted, true);

/**
 * Watch occurrence batch (C2). `batch` is the canonical JSON of the observed
 * occurrences; `epoch` fences superseded watchers into no-ops (F2).
 */
export const WatchFiredRpc = Rpc.make("WatchFired", {
  payload: {
    watchId: Schema.String,
    epoch: Schema.Number,
    sourceKey: Schema.String,
    batch: Schema.String,
  },
  success: TimerReceipt,
}).annotate(ClusterSchema.Persisted, true);

/** Watch timeout wake (C2); the chain fold decides applied-versus-noop. */
class WatchTimeoutPayload extends Schema.Class<WatchTimeoutPayload>(
  "@openomni/agent/cluster/WatchTimeoutPayload",
)({
  watchId: Schema.String,
  epoch: Schema.Number,
  fireAt: Schema.Number,
}) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return DateTime.makeUnsafe(this.fireAt);
  }
}

export const WatchTimeoutRpc = Rpc.make("WatchTimeout", {
  payload: WatchTimeoutPayload,
  success: TimerReceipt,
}).annotate(ClusterSchema.Persisted, true);

/** A policy refusal is ordinary session data, not an exception: the turn settled as refused. */
export class SessionPolicyRefusal {
  readonly _tag = "SessionPolicyRefusal";
  readonly code = "session_policy_refused";

  constructor(readonly reason: string) {}

  get message(): string {
    return "session policy refused";
  }
}

// ─── #1253: the four-entity-RPC surface ───

/**
 * Typed `deliver` rejection (#1253): the closed code set is exactly
 * `unknown_kind | missing_key | closed | denied`. A rejection appends
 * nothing — zero new journal facts ride a refused delivery.
 */
export class DeliverRefused extends Schema.TaggedError<DeliverRefused>(
  "@openomni/agent/cluster/DeliverRefused",
)("DeliverRefused", {
  code: Schema.Literals(["unknown_kind", "missing_key", "closed", "denied"]),
}) {}

/**
 * Typed `resolve` rejection (#1253): a missing or already-settled request is
 * refused before the request authority runs, so a stale response appends no
 * journal fact.
 */
export class ResolveRefused extends Schema.TaggedError<ResolveRefused>(
  "@openomni/agent/cluster/ResolveRefused",
)("ResolveRefused", {
  code: Schema.Literals(["unknown_request", "already_resolved"]),
}) {}

/** `deliver` success: the input row's seq; `existed` marks an idempotent replay. */
export const DeliverReceipt = Schema.Struct({
  seq: Schema.Number,
  existed: Schema.Boolean,
});
export type DeliverReceipt = typeof DeliverReceipt.Type;

/**
 * One delivered input (#1253). `kind` is the journal row kind the input lands
 * as and is checked against the activation's input registration table (the
 * core registers `prompt` and `signal`; the action capability registers
 * `action`). `body` is the canonical JSON of `{content, control?, delivery?}`
 * — `control: interrupt|resume` selects the signal, `delivery: steer|followUp`
 * the consumption boundary (default `followUp`). `source` is the canonical
 * JSON of the protocol origin value. `idempotencyKey` is required and caller
 * chosen: it is the durable row id and the cluster primary key, so replays
 * resolve to the original seq.
 */
export const DeliverRpc = Rpc.make("Deliver", {
  payload: {
    kind: Schema.String,
    body: Schema.String,
    source: Schema.String,
    idempotencyKey: Schema.String,
  },
  success: DeliverReceipt,
  error: DeliverRefused,
  primaryKey: (payload) => payload.idempotencyKey,
}).annotate(ClusterSchema.Persisted, true);

/**
 * One request settlement (#1253). `payload` is the canonical JSON of a
 * `SessionTransition.Payload` for `resolved`, or of the acting principal for
 * `cancelled`. `inputId` is the durable idempotency key the pure request
 * authority dedupes on.
 */
export const ResolveRpc = Rpc.make("Resolve", {
  payload: {
    requestId: Schema.String,
    outcome: Schema.Literals(["resolved", "cancelled"]),
    payload: Schema.String,
    inputId: Schema.String,
  },
  success: RequestReceipt,
  error: ResolveRefused,
  primaryKey: (payload) => payload.inputId,
}).annotate(ClusterSchema.Persisted, true);

/** The alarm purposes the core dispatches today; #1254 owns the purpose set. */
export const AlarmPurpose = Schema.Literals(["retry", "deadline", "watch.fired", "watch.timeout"]);
export type AlarmPurpose = typeof AlarmPurpose.Type;

/** Purpose-shaped alarm bodies (canonical JSON of `AlarmRpc.body`). */
export const RetryAlarmBody = Schema.Struct({ alarmId: Schema.String, attempt: Schema.Number });
export const DeadlineAlarmBody = Schema.Struct({ requestId: Schema.String });
export const WatchFiredAlarmBody = Schema.Struct({
  watchId: Schema.String,
  epoch: Schema.Number,
  sourceKey: Schema.String,
  batch: Schema.String,
});
export const WatchTimeoutAlarmBody = Schema.Struct({
  watchId: Schema.String,
  epoch: Schema.Number,
});

/**
 * One alarm occurrence (#1253): `occurrenceId` is the cluster primary key and
 * the chain-guard identity; `fireAt` is the DeliverAt instant. A superseded
 * occurrence folds to a recorded `alarm{fired, outcome: stale}` fact and never
 * wakes the loop — a stale occurrence is a fact, not a rejection.
 */
export class AlarmOccurrence extends Schema.Class<AlarmOccurrence>(
  "@openomni/agent/cluster/AlarmOccurrence",
)({
  occurrenceId: Schema.String,
  purpose: AlarmPurpose,
  body: Schema.String,
  fireAt: Schema.Number,
}) {
  [PrimaryKey.symbol](): string {
    return this.occurrenceId;
  }
  [DeliverAt.symbol](): DateTime.DateTime {
    return DateTime.makeUnsafe(this.fireAt);
  }
}

/** Alarm ack: the occurrence either drove the fold or folded to a stale fact. */
export const AlarmReceipt = Schema.Struct({
  outcome: Schema.Literals(["delivered", "stale"]),
});
export type AlarmReceipt = typeof AlarmReceipt.Type;

export const AlarmRpc = Rpc.make("Alarm", {
  payload: AlarmOccurrence,
  success: AlarmReceipt,
}).annotate(ClusterSchema.Persisted, true);

/**
 * The canonical JSON body one `deliver` carries: the input content, the
 * signal control op when `kind` is `signal`, and the loop-consumption
 * delivery (`steer | followUp`, default `followUp`).
 */
export const DeliverBody = Schema.Struct({
  content: Schema.String,
  control: Schema.optional(Schema.Literals(["interrupt", "resume"])),
  delivery: Schema.optional(Schema.Literals(["steer", "followUp"])),
});
export type DeliverBody = typeof DeliverBody.Type;
