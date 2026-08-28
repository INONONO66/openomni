import { z } from "zod";
import { NamedError } from "../error/index.js";

export const OwnerKind = z.enum(["workItem", "session"]);
export type OwnerKind = z.infer<typeof OwnerKind>;

export const OwnerRef = z
  .object({
    kind: OwnerKind,
    id: z.string().min(1),
  })
  .strict();
export type OwnerRef = z.infer<typeof OwnerRef>;

export const Status = z.enum(["open", "resolved", "expired", "cancelled"]);
export type Status = z.infer<typeof Status>;

export const AllowedAction = z.enum([
  "report_result",
  "ask_clarification",
  "attach_artifact",
  "decline_task",
]);
export type AllowedAction = z.infer<typeof AllowedAction>;

/** Single owner of reply-correlation fields (#215). */
export const Correlation = z
  .object({
    endpointId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    replyToMessageId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    tokenHash: z.string().min(1).optional(),
    externalConversationId: z.string().min(1).optional(),
    /**
     * Engagement resumption context (#709): stamped by an engagement-scoped
     * awaited send and copied into `Gateway.WaitContext.engagementId` at
     * delivery. NEVER a matching key — `CorrelationQuery` has no slot for it,
     * so it cannot influence which wait an inbound message resumes
     * (gateway-design §5: authority is independent of engagement matching).
     */
    engagementId: z.string().min(1).optional(),
  })
  .strict();
export type Correlation = z.infer<typeof Correlation>;

export const ResolutionPolicy = z.enum(["first_reply", "quorum", "all"]);
export type ResolutionPolicy = z.infer<typeof ResolutionPolicy>;

export const Quorum = z
  .object({
    expected: z.number().int().min(1),
    threshold: z.number().int().min(1),
  })
  .strict()
  .refine((quorum) => quorum.threshold <= quorum.expected, {
    message: "quorum threshold cannot exceed expected responder count",
  });
export type Quorum = z.infer<typeof Quorum>;

export const Reply = z
  .object({
    /** Caller-supplied reply identity key: the duplicate rule dedupes on it. */
    replyKey: z.string().min(1),
    responderId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    receivedAt: z.number(),
  })
  .strict();
export type Reply = z.infer<typeof Reply>;

const RecordBase = z
  .object({
    id: z.string().min(1),
    ownerRef: OwnerRef,
    /**
     * The awaited outbound message that opened this Wait. Uniqueness
     * ("exactly one Wait per awaited message") is enforced at write time by
     * the `wait.origin_message_id` UNIQUE column — the single owner of that
     * invariant.
     */
    originMessageId: z.string().min(1),
    correlation: Correlation,
    allowedActions: z.array(AllowedAction).min(1),
    expectedResponders: z.array(z.string().min(1)).min(1),
    resolutionPolicy: ResolutionPolicy,
    quorum: Quorum.optional(),
    status: Status,
    partial: z.boolean(),
    replies: z.array(Reply),
    revision: z.number().int().nonnegative(),
    expiresAt: z.number(),
    followUpWindow: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
    resolvedAt: z.number().optional(),
    cancelledAt: z.number().optional(),
  })
  .strict();

function validateResolution(
  item: {
    expectedResponders: string[];
    resolutionPolicy: ResolutionPolicy;
    quorum?: Quorum;
  },
  ctx: z.RefinementCtx,
): void {
  if (new Set(item.expectedResponders).size !== item.expectedResponders.length) {
    ctx.addIssue({
      code: "custom",
      message: "expected responders must be unique",
      path: ["expectedResponders"],
    });
  }
  if (item.resolutionPolicy === "quorum") {
    if (item.quorum === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "resolutionPolicy quorum requires quorum bounds",
        path: ["quorum"],
      });
      return;
    }
    if (item.quorum.expected !== item.expectedResponders.length) {
      ctx.addIssue({
        code: "custom",
        message: "quorum.expected must equal the expected responder count",
        path: ["quorum", "expected"],
      });
    }
    return;
  }
  if (item.quorum !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "quorum bounds require resolutionPolicy quorum",
      path: ["quorum"],
    });
  }
}

export const Record = RecordBase.superRefine(validateResolution);
export type Record = z.infer<typeof Record>;

/**
 * Input shape for opening a Wait. Not separately refined: the Record factory
 * (`Record.parse` at WaitStore.create) is the one enforcement layer for
 * resolution-policy coherence.
 */
export const Create = RecordBase.omit({
  status: true,
  partial: true,
  replies: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  cancelledAt: true,
}).extend({
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
export type Create = z.infer<typeof Create>;

export const CorrelationQuery = z
  .object({
    endpointId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    replyToMessageId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    tokenHash: z.string().min(1).optional(),
    externalConversationId: z.string().min(1).optional(),
  })
  .strict()
  .refine((query) => Object.values(query).some((value) => value !== undefined), {
    message: "At least one correlation field is required",
  });
export type CorrelationQuery = z.infer<typeof CorrelationQuery>;

export const StoreErrorCode = z.enum([
  "adapter_absent",
  "duplicate",
  "not_found",
  "revision_conflict",
  /** Storage was busy (SQLITE_BUSY at the transaction entry) — nothing was written; retrying is the caller's decision. */
  "unavailable",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCode>;

/**
 * Typed failure taxonomy for durable Wait persistence. A missing sub-adapter
 * is `adapter_absent` — durable writes fail closed, never warn-and-return
 * (#215 owner decision 1). Callers branch on `data.code`, never message text.
 */
export const StoreError = NamedError.create(
  "WaitStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    waitId: z.string().min(1).optional(),
  }),
);
