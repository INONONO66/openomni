import { DateTime, PrimaryKey, Schema } from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc } from "effect/rpc";

/**
 * The Session entity wire protocol (#1253): exactly four RPCs — `deliver`,
 * `resolve`, `alarm`, `read`. The three writers are persisted: envelopes
 * survive in the runner storage until the handler acks, and the ack is sent
 * only after the corresponding ledger commit, so a crash between commit and
 * ack yields redelivery, never loss (F4). Handlers dedupe redelivered
 * envelopes by durable chain identity (`idempotencyKey` for inputs, `inputId`
 * for settlements, `occurrenceId` for alarms), so at-least-once delivery
 * folds to exactly-once ledger effects. `read` is a pure projection and is
 * not persisted.
 */

/** Ack for a request settlement; carries the pure authority's resolution token. */
const RequestReceipt = Schema.Struct({ resolution: Schema.String });

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
 * Typed admission failure (#1254 S4): the single writer bounds the revision
 * CAS to three attempts (`code: "revision"`) and answers requests left in the
 * queue at scope close with `code: "shutdown"`. Both are refusals of THIS
 * delivery attempt — the persisted envelope redelivers.
 */
export class AdmissionFailure extends Schema.TaggedError<AdmissionFailure>(
  "@openomni/agent/cluster/AdmissionFailure",
)("AdmissionFailure", {
  code: Schema.Literals(["revision", "shutdown"]),
}) {}

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
  error: Schema.Union([DeliverRefused, AdmissionFailure]),
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
  error: Schema.Union([ResolveRefused, AdmissionFailure]),
  primaryKey: (payload) => payload.inputId,
}).annotate(ClusterSchema.Persisted, true);

/** Purpose-shaped alarm payloads (canonical JSON of `AlarmOccurrence.payload`). */
export const DeadlineAlarmBody = Schema.Struct({ requestId: Schema.String });


/**
 * One alarm occurrence (#1254): `occurrenceId` is the cluster primary key and
 * the chain-guard identity; `alarmId`/`armSeq`/`sourceKey` are the minter
 * inputs that reproduce it; `purpose` is an open string resolved against the
 * composed purpose registry; `fireAt` is the DeliverAt instant. A superseded
 * occurrence folds to a recorded `alarm{fired, outcome: stale}` fact and never
 * wakes the loop — a stale occurrence is a fact, not a rejection.
 */
export class AlarmOccurrence extends Schema.Class<AlarmOccurrence>(
  "@openomni/agent/cluster/AlarmOccurrence",
)({
  occurrenceId: Schema.String,
  purpose: Schema.String,
  alarmId: Schema.String,
  armSeq: Schema.Number,
  sourceKey: Schema.String,
  /** Canonical JSON of the arm's payload. */
  payload: Schema.String,
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
  error: AdmissionFailure,
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

/** The nine read models (#1253) the `read` RPC serves from the journal fold. */
const ReadModelName = Schema.Literals([
  "history",
  "decisions",
  "requests",
  "alarms",
  "generations",
  "tree",
  "metrics",
  "control",
  "outbound",
]);

/**
 * One read page: `body` is the canonical JSON of the rendered model page
 * (see `core/read.ts`); `nextCursor` is the next after-revision, or null
 * when the page reached the chain head.
 */
export const ReadPage = Schema.Struct({
  body: Schema.String,
  nextCursor: Schema.NullOr(Schema.Number),
});
export type ReadPage = typeof ReadPage.Type;

/**
 * `read{model, cursor}` (#1253): the entity's fourth RPC. A pure projection
 * over the committed chain — it appends nothing and never wakes the loop, so
 * it is deliberately NOT cluster-persisted.
 */
export const ReadRpc = Rpc.make("Read", {
  payload: {
    model: ReadModelName,
    cursor: Schema.Number,
  },
  success: ReadPage,
  error: AdmissionFailure,
});
