import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { NamedError } from "../error/index.js";

export const Status = z.enum(["open", "resolved", "follow_up", "expired", "cancelled"]);
export type Status = z.infer<typeof Status>;

export const AllowedAction = z.enum([
  "report_result",
  "ask_clarification",
  "attach_artifact",
  "decline_task",
]);
export type AllowedAction = z.infer<typeof AllowedAction>;

export const Correlation = z
  .object({
    replyToMessageId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    tokenHash: z.string().min(1).optional(),
    externalConversationId: z.string().min(1).optional(),
  })
  .strict()
  .default({});
export type Correlation = z.infer<typeof Correlation>;

export const Record = z
  .object({
    id: z.string().min(1),
    workerRunId: z.string().min(1),
    sessionId: z.string().min(1),
    targetActorId: z.string().min(1).optional(),
    endpointId: z.string().min(1),
    channelId: z.string().min(1),
    correlation: Correlation,
    allowedActions: z.array(AllowedAction).min(1),
    status: Status,
    createdAt: z.number(),
    updatedAt: z.number(),
    expiresAt: z.number(),
    followUpWindow: z.number().int().nonnegative(),
    resolvedAt: z.number().optional(),
    cancelledAt: z.number().optional(),
  })
  .strict();
export type Record = z.infer<typeof Record>;

export const Create = Record.omit({
  status: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  cancelledAt: true,
}).extend({
  status: Status.optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
export type Create = z.infer<typeof Create>;

export const WriteMethod = z.enum([
  "create",
  "resolve",
  "markFollowUp",
  "cancel",
  "cleanupExpired",
]);
export type WriteMethod = z.infer<typeof WriteMethod>;

/**
 * #548 — PendingInteraction is a frozen legacy writer. Its dispatch-side
 * consumers cut over to durable Wait correlation (#215 vocabulary), so every
 * `PendingInteractionStore` write method throws this typed error. Callers
 * branch on `data.code`, never message text. Historical rows stay readable
 * through the store's read methods and the upcast-on-read Wait view; the
 * archive manifest (script/generate-ledger-archive-manifest.ts) records
 * their range identity and integrity hash.
 */
export const FrozenError = NamedError.create(
  "PendingInteractionFrozenError",
  z.object({
    message: z.string(),
    code: z.literal("pending_interaction_frozen"),
    method: WriteMethod,
  }),
);

export const CorrelationQuery = z
  .object({
    replyToMessageId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    tokenHash: z.string().min(1).optional(),
    externalConversationId: z.string().min(1).optional(),
    endpointId: z.string().min(1),
    channelId: z.string().min(1),
  })
  .strict();
export type CorrelationQuery = z.infer<typeof CorrelationQuery>;

const EventBase = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  workerRunId: z.string().min(1),
  sessionId: z.string().min(1),
  endpointId: z.string().min(1),
  channelId: z.string().min(1),
  status: Status,
  time: z.number(),
});

export const Events = {
  Opened: BusEvent.define("pending_interaction.opened", EventBase, { visibility: "llm_reason" }),
  Resolved: BusEvent.define(
    "pending_interaction.resolved",
    EventBase.extend({ resolvedAt: z.number() }),
    { visibility: "llm_reason" },
  ),
  FollowUp: BusEvent.define("pending_interaction.follow_up", EventBase, {
    visibility: "llm_reason",
  }),
  Cancelled: BusEvent.define(
    "pending_interaction.cancelled",
    EventBase.extend({ cancelledAt: z.number() }),
    { visibility: "llm_reason" },
  ),
  Expired: BusEvent.define("pending_interaction.expired", EventBase, { visibility: "llm_reason" }),
} as const;
