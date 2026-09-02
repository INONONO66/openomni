import { z } from "zod";
import { NamedError } from "../error/index.js";
import { canonicalDigest } from "../json.js";
import { EpochMs } from "../time.js";

export const Constants = {
  ACTIVE_TRIGGER_CAP: 5,
  TRANSITION_BATCH_CAP: 6,
  MIN_RECURRING_INTERVAL_MS: 60_000,
  RECURRING_LIFETIME_MS: 604_800_000,
  SOURCE_TIMEOUT_MS: 300_000,
  SOURCE_KILL_GRACE_MS: 1_000,
  DELIVERY_RETRY_BASE_MS: 1_000,
  DELIVERY_RETRY_MAX_MS: 60_000,
  MAX_COMMAND_CHARS: 8_192,
  MAX_FILTER_CHARS: 1_024,
  MAX_PATH_CHARS: 4_096,
  NOTIFIER_COALESCE_WINDOW_MS: 2_000,
  NOTIFIER_RATE_LIMIT_MS: 5_000,
  NOTIFIER_MAX_LINES: 50,
  NOTIFIER_MAX_CHARS: 4_096,
  NOTIFIER_WAKE_BUDGET: 5,
  QUEUE_OVERHEAD_CHARS: 512,
  WAKE_STREAK_QUIET_GAP_MULTIPLIER: 2,
  MAX_PROMPT_CHARS: 16_384,
  MAX_EVENT_TEXT_CHARS: 1_024,
  MAX_DETAIL_CHARS: 1_024,
  FIRE_ENVELOPE_CHARS: 512,
  MAX_FIRE_PAYLOAD_CHARS: 20_992,
  MAX_PARTIAL_LINE_CHARS: 1_024,
  MAX_TRIGGER_LIST_ROWS: 100,
  MAX_COUNTER: Number.MAX_SAFE_INTEGER,
  SET_TIMEOUT_MAX_MS: 2_147_483_647,
  FILE_DIGEST_SAMPLE_BYTES: 65_536,
  FILE_SAFETY_POLL_MS: 250,
  FILE_DIRTY_RECHECK_LIMIT: 1,
} as const;

export const Kinds = ["time.once", "time.every", "event.command", "event.file"] as const;
export type KindName = (typeof Kinds)[number];
export const LifecycleStates = ["armed", "paused", "ended"] as const;
export type LifecycleState = (typeof LifecycleStates)[number];
export const FireStatuses = ["recorded", "delivered", "acked"] as const;
export type FireStatus = (typeof FireStatuses)[number];
export const SourceEventKinds = ["line", "summary"] as const;

const PositiveSafeInt = z.number().int().positive().max(Constants.MAX_COUNTER);
const NonNegativeSafeInt = z.number().int().min(0).max(Constants.MAX_COUNTER);

export const CanonicalDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type CanonicalDigest = z.infer<typeof CanonicalDigest>;

const CommandSource = z
  .object({
    kind: z.literal("event.command"),
    command: z.string().min(1).max(Constants.MAX_COMMAND_CHARS),
    filter: z.string().max(Constants.MAX_FILTER_CHARS).optional(),
    persistent: z.boolean(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.command.includes("\0")) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "command contains NUL" });
    }
    if (source.filter !== undefined) {
      try {
        new RegExp(source.filter);
      } catch {
        ctx.addIssue({ code: "custom", path: ["filter"], message: "invalid regular expression" });
      }
    }
  });

export const Source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time.once"), at: EpochMs }).strict(),
  z.object({ kind: z.literal("time.every"), intervalMs: PositiveSafeInt }).strict(),
  CommandSource,
  z
    .object({
      kind: z.literal("event.file"),
      path: z.string().min(1).max(Constants.MAX_PATH_CHARS),
      on: z.enum(["create", "modify"]),
    })
    .strict(),
]);
export type Source = z.infer<typeof Source>;

export const CreateSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time.once"), at: EpochMs }).strict(),
  z.object({ kind: z.literal("time.every"), intervalMs: PositiveSafeInt }).strict(),
  z
    .object({
      kind: z.literal("event.command"),
      command: z.string().min(1).max(Constants.MAX_COMMAND_CHARS),
      filter: z.string().max(Constants.MAX_FILTER_CHARS).optional(),
      persistent: z.boolean().default(false),
    })
    .strict()
    .superRefine((source, ctx) => {
      if (source.command.includes("\0")) {
        ctx.addIssue({ code: "custom", path: ["command"], message: "command contains NUL" });
      }
      if (source.filter !== undefined) {
        try {
          new RegExp(source.filter);
        } catch {
          ctx.addIssue({ code: "custom", path: ["filter"], message: "invalid regular expression" });
        }
      }
    }),
  z
    .object({
      kind: z.literal("event.file"),
      path: z.string().min(1).max(Constants.MAX_PATH_CHARS),
      on: z.enum(["create", "modify"]).default("create"),
    })
    .strict(),
]);
export type CreateSource = z.infer<typeof CreateSource>;

export const PauseReason = z.enum([
  "wake_budget",
  "source_unavailable",
  "owner_session_missing",
  "recovery_conflict",
]);
export type PauseReason = z.infer<typeof PauseReason>;

export const EndReason = z.enum([
  "cancelled",
  "completed",
  "expired",
  "source_exited",
  "source_timeout",
  "source_error",
]);
export type EndReason = z.infer<typeof EndReason>;

export const TerminalFireReason = z.enum([
  "cancelled",
  "completed",
  "source_exited",
  "source_timeout",
  "source_error",
]);
export type TerminalFireReason = z.infer<typeof TerminalFireReason>;

export const Lifecycle = z.discriminatedUnion("state", [
  z.object({ state: z.literal("armed") }).strict(),
  z
    .object({
      state: z.literal("paused"),
      pauseReason: PauseReason,
      pausedAt: EpochMs,
    })
    .strict(),
  z
    .object({
      state: z.literal("ended"),
      endReason: EndReason,
      endedAt: EpochMs,
      endDetail: z.string().max(Constants.MAX_DETAIL_CHARS).optional(),
    })
    .strict(),
]);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const SourceItem = z
  .object({
    kind: z.enum(SourceEventKinds),
    text: z.string().min(1).max(Constants.MAX_EVENT_TEXT_CHARS),
    at: EpochMs,
  })
  .strict();
export type SourceItem = z.infer<typeof SourceItem>;

function pendingFingerprint(batch: Omit<PendingBatch, "fingerprint">): string {
  return canonicalDigest({
    items: batch.items,
    overflowCount: batch.overflowCount,
    scheduleMarker: batch.scheduleMarker,
    ...(batch.scheduledForAt === undefined ? {} : { scheduledForAt: batch.scheduledForAt }),
    firstAt: batch.firstAt,
    lastAt: batch.lastAt,
    ...(batch.terminalReason === undefined ? {} : { terminalReason: batch.terminalReason }),
  });
}

const PendingBatchBase = z
  .object({
    items: z.array(SourceItem).max(Constants.NOTIFIER_MAX_LINES),
    overflowCount: NonNegativeSafeInt,
    scheduleMarker: z.boolean(),
    scheduledForAt: EpochMs.optional(),
    firstAt: EpochMs,
    lastAt: EpochMs,
    terminalReason: TerminalFireReason.optional(),
    fingerprint: CanonicalDigest,
  })
  .strict();

export const PendingBatch = PendingBatchBase.superRefine((batch, ctx) => {
  if (batch.firstAt > batch.lastAt) {
    ctx.addIssue({ code: "custom", path: ["lastAt"], message: "lastAt precedes firstAt" });
  }
  if (batch.items.some((item) => item.at < batch.firstAt || item.at > batch.lastAt)) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "item timestamp is outside batch" });
  }
  const summaries = batch.items.filter((item) => item.kind === "summary").length;
  if (summaries > 1) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "batch has multiple summaries" });
  }
  if (batch.scheduleMarker) {
    if (
      batch.items.length !== 0 ||
      batch.overflowCount !== 0 ||
      batch.scheduledForAt === undefined ||
      batch.terminalReason !== undefined
    ) {
      ctx.addIssue({ code: "custom", message: "invalid recurring schedule marker" });
    }
  } else {
    if (batch.scheduledForAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["scheduledForAt"],
        message: "source batch has a schedule",
      });
    }
    if (batch.items.length === 0 && batch.overflowCount === 0) {
      ctx.addIssue({ code: "custom", message: "empty source batch" });
    }
  }
  if ((batch.terminalReason !== undefined) !== (summaries === 1)) {
    ctx.addIssue({
      code: "custom",
      path: ["terminalReason"],
      message: "terminal reason requires one summary",
    });
  }
  const rendered = batch.items.reduce(
    (total, item) => total + item.kind.length + item.text.length + 4,
    batch.overflowCount > 0 ? String(batch.overflowCount).length + 48 : 0,
  );
  if (rendered > Constants.NOTIFIER_MAX_CHARS - Constants.QUEUE_OVERHEAD_CHARS) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "batch rendered budget exceeded" });
  }
  const { fingerprint: _fingerprint, ...facts } = batch;
  if (batch.fingerprint !== pendingFingerprint(facts)) {
    ctx.addIssue({ code: "custom", path: ["fingerprint"], message: "batch fingerprint mismatch" });
  }
});
export type PendingBatch = z.infer<typeof PendingBatchBase>;

const RecordBase = z
  .object({
    id: z.string().min(1),
    ownerSessionId: z.string().min(1),
    prompt: z.string().min(1).max(Constants.MAX_PROMPT_CHARS),
    source: Source,
    lifecycle: Lifecycle,
    createdAt: EpochMs,
    updatedAt: EpochMs,
    revision: PositiveSafeInt,
    expiresAt: EpochMs.optional(),
    requestedIntervalMs: PositiveSafeInt.optional(),
    effectiveIntervalMs: PositiveSafeInt.optional(),
    nextFireAt: EpochMs.optional(),
    lastObservedAt: EpochMs,
    lastFiredAt: EpochMs.optional(),
    fireCount: NonNegativeSafeInt,
    inFlightFireId: z.string().min(1).optional(),
    coalescedFirePending: z.boolean(),
    pendingBatch: PendingBatch.optional(),
  })
  .strict();

export const Record = RecordBase.superRefine((record, ctx) => {
  if (record.updatedAt < record.createdAt || record.lastObservedAt < record.createdAt) {
    ctx.addIssue({ code: "custom", message: "Trigger time precedes creation" });
  }
  if (record.updatedAt < record.lastObservedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "updatedAt precedes observation",
    });
  }
  if (record.coalescedFirePending !== (record.pendingBatch !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["pendingBatch"], message: "pending flag mismatch" });
  }
  if (record.pendingBatch !== undefined && record.inFlightFireId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["pendingBatch"],
      message: "pending batch has no in-flight Fire",
    });
  }
  switch (record.source.kind) {
    case "time.once":
      if (
        record.nextFireAt !== undefined ||
        record.expiresAt !== undefined ||
        record.requestedIntervalMs !== undefined ||
        record.effectiveIntervalMs !== undefined
      ) {
        ctx.addIssue({ code: "custom", message: "time.once carries recurring fields" });
      }
      break;
    case "time.every":
      if (
        record.nextFireAt === undefined ||
        record.expiresAt === undefined ||
        record.requestedIntervalMs === undefined ||
        record.effectiveIntervalMs === undefined ||
        record.effectiveIntervalMs < Constants.MIN_RECURRING_INTERVAL_MS ||
        record.source.intervalMs !== record.effectiveIntervalMs ||
        record.nextFireAt > record.expiresAt
      ) {
        ctx.addIssue({ code: "custom", message: "invalid time.every scheduling projection" });
      }
      break;
    case "event.command":
      if (
        record.nextFireAt !== undefined ||
        record.requestedIntervalMs !== undefined ||
        record.effectiveIntervalMs !== undefined ||
        (record.source.persistent ? record.expiresAt !== undefined : record.expiresAt === undefined)
      ) {
        ctx.addIssue({ code: "custom", message: "invalid command scheduling projection" });
      }
      break;
    case "event.file":
      if (
        record.nextFireAt !== undefined ||
        record.expiresAt === undefined ||
        record.requestedIntervalMs !== undefined ||
        record.effectiveIntervalMs !== undefined
      ) {
        ctx.addIssue({ code: "custom", message: "invalid file scheduling projection" });
      }
      break;
  }
  if (record.lifecycle.state === "ended" && record.pendingBatch !== undefined) {
    const legal =
      record.pendingBatch.scheduleMarker || record.pendingBatch.terminalReason !== undefined;
    if (!legal)
      ctx.addIssue({
        code: "custom",
        path: ["pendingBatch"],
        message: "ended Trigger has ordinary pending work",
      });
  }
});
export type Record = z.infer<typeof RecordBase>;

export const Create = z
  .object({
    id: z.string().min(1),
    ownerSessionId: z.string().min(1),
    prompt: z.string().min(1).max(Constants.MAX_PROMPT_CHARS),
    source: CreateSource,
    at: EpochMs,
  })
  .strict();
export type Create = z.infer<typeof Create>;

export const FireCause = z.enum([
  "alarm",
  "source_line",
  "source_summary",
  "recovery",
  "coalesced",
]);
export type FireCause = z.infer<typeof FireCause>;

export const FireAdmission = z
  .object({
    fireId: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    payloadDigest: CanonicalDigest,
    admittedAt: EpochMs,
  })
  .strict();
export type FireAdmission = z.infer<typeof FireAdmission>;

const FireReservationBase = z
  .object({
    id: z.string().min(1),
    traceId: z.string().min(1),
    payload: z.string().min(1).max(Constants.MAX_FIRE_PAYLOAD_CHARS),
    payloadDigest: CanonicalDigest,
    cause: FireCause,
    terminalReason: TerminalFireReason.optional(),
    sourceItems: z.array(SourceItem).max(Constants.NOTIFIER_MAX_LINES),
    overflowCount: NonNegativeSafeInt,
    scheduledForAt: EpochMs.optional(),
    firedAt: EpochMs,
  })
  .strict();

function validateReservation(
  fire: z.infer<typeof FireReservationBase>,
  ctx: z.RefinementCtx,
): void {
  if (fire.payloadDigest !== canonicalDigest(fire.payload)) {
    ctx.addIssue({ code: "custom", path: ["payloadDigest"], message: "payload digest mismatch" });
  }
  if (fire.scheduledForAt !== undefined && fire.scheduledForAt > fire.firedAt) {
    ctx.addIssue({ code: "custom", path: ["scheduledForAt"], message: "schedule follows firing" });
  }
  const summaries = fire.sourceItems.filter((item) => item.kind === "summary").length;
  if (
    fire.terminalReason !== undefined &&
    summaries === 0 &&
    !(fire.terminalReason === "completed" && fire.scheduledForAt !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["terminalReason"],
      message: "terminal Fire lacks summary",
    });
  }
  if (fire.scheduledForAt !== undefined && fire.sourceItems.length > 0) {
    ctx.addIssue({ code: "custom", message: "scheduled Fire carries source items" });
  }
  if (
    (fire.cause === "alarm" || fire.cause === "recovery") &&
    (fire.scheduledForAt === undefined || fire.sourceItems.length !== 0)
  ) {
    ctx.addIssue({ code: "custom", path: ["cause"], message: "alarm shape mismatch" });
  }
  if (fire.cause === "source_line" && fire.sourceItems.some((item) => item.kind !== "line")) {
    ctx.addIssue({ code: "custom", path: ["cause"], message: "source_line carries summary" });
  }
  if (fire.cause === "source_summary" && summaries !== 1) {
    ctx.addIssue({ code: "custom", path: ["cause"], message: "source_summary lacks summary" });
  }
}

export const FireReservation = FireReservationBase.superRefine(validateReservation);
export type FireReservation = z.infer<typeof FireReservationBase>;

const FireBase = FireReservationBase.extend({
  triggerId: z.string().min(1),
  ownerSessionId: z.string().min(1),
  recordedAt: EpochMs,
  status: z.enum(FireStatuses),
  deliveryAttempts: NonNegativeSafeInt,
  deliveredAt: EpochMs.optional(),
  ackedAt: EpochMs.optional(),
  admission: FireAdmission.optional(),
  revision: PositiveSafeInt,
  updatedAt: EpochMs,
}).strict();

export const Fire = FireBase.superRefine((fire, ctx) => {
  validateReservation(fire, ctx);
  if (fire.firedAt > fire.recordedAt || fire.recordedAt > fire.updatedAt) {
    ctx.addIssue({ code: "custom", message: "Fire timestamps are not monotonic" });
  }
  if (fire.status === "recorded") {
    if (
      fire.deliveredAt !== undefined ||
      fire.ackedAt !== undefined ||
      fire.admission !== undefined
    ) {
      ctx.addIssue({ code: "custom", message: "recorded Fire carries later receipts" });
    }
    return;
  }
  if (fire.deliveredAt === undefined || fire.deliveredAt < fire.recordedAt) {
    ctx.addIssue({ code: "custom", path: ["deliveredAt"], message: "delivered receipt missing" });
  }
  if (fire.status === "delivered") {
    if (fire.ackedAt !== undefined || fire.admission !== undefined) {
      ctx.addIssue({ code: "custom", message: "delivered Fire carries ack receipt" });
    }
    return;
  }
  if (fire.ackedAt === undefined || fire.admission === undefined) {
    ctx.addIssue({ code: "custom", message: "acked Fire lacks admission" });
    return;
  }
  if (
    fire.admission.fireId !== fire.id ||
    fire.admission.sessionId !== fire.ownerSessionId ||
    fire.admission.payloadDigest !== fire.payloadDigest ||
    fire.admission.admittedAt < (fire.deliveredAt ?? 0) ||
    fire.ackedAt < fire.admission.admittedAt
  ) {
    ctx.addIssue({ code: "custom", path: ["admission"], message: "Fire admission mismatch" });
  }
});
export type Fire = z.infer<typeof FireBase>;

export const FireMaterial = z
  .object({
    reservation: FireReservation,
    pendingBatch: PendingBatch,
  })
  .strict();
export type FireMaterial = z.infer<typeof FireMaterial>;

export const StoreErrorCode = z.enum([
  "adapter_absent",
  "unavailable",
  "duplicate",
  "not_found",
  "revision_conflict",
  "invalid_transition",
  "active_cap",
  "corrupt",
  "admission_conflict",
  "owner_session_missing",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCode>;

export const StoreError = NamedError.create(
  "TriggerStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    triggerId: z.string().min(1).optional(),
    fireId: z.string().min(1).optional(),
  }),
);
