import { z } from "zod";
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

export const Record = z
  .object({
    id: z.string().min(1),
    workerRunId: z.string().min(1),
    sessionId: z.string().min(1),
    targetActorId: z.string().min(1).optional(),
    endpointId: z.string().min(1),
    channelId: z.string().min(1),
    // FROZEN read vocabulary (#498 C3): the legacy correlation fields live
    // inline on the Record only — Wait.Correlation is the one live shape.
    correlation: z
      .object({
        replyToMessageId: z.string().min(1).optional(),
        threadId: z.string().min(1).optional(),
        tokenHash: z.string().min(1).optional(),
        externalConversationId: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
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

const WriteMethod = z.enum(["create", "resolve", "markFollowUp", "cancel", "cleanupExpired"]);

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
