import { DateTime, Schema } from "effect";
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
});
export type ChainAppendReceipt = typeof ChainAppendReceipt.Type;

/** Ack for a request command; carries the pure authority's resolution token. */
export const RequestReceipt = Schema.Struct({ resolution: Schema.String });
export type RequestReceipt = typeof RequestReceipt.Type;

/** Timer acks distinguish applied work from a chain-guarded no-op (F2). */
export const TimerReceipt = Schema.Struct({
  outcome: Schema.Literals(["applied", "noop"]),
});
export type TimerReceipt = typeof TimerReceipt.Type;

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
export class RetryScheduledPayload extends Schema.Class<RetryScheduledPayload>(
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
export class DeadlinePayload extends Schema.Class<DeadlinePayload>(
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
export class WatchTimeoutPayload extends Schema.Class<WatchTimeoutPayload>(
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
