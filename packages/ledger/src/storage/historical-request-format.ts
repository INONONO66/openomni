import { z } from "zod";

// Frozen archive formats only. Never exported as live protocol or store APIs.
const EpochMs = z.number().finite().nonnegative();

export const HistoricalWait = (() => {
  const OwnerKind = z.enum(["session", "workItem"]);

  const OwnerRef = z
    .object({
      kind: OwnerKind,
      id: z.string().min(1),
    })
    .strict();

  const Status = z.enum(["open", "resolved", "expired", "cancelled"]);

  const AllowedAction = z.enum([
    "report_result",
    "ask_clarification",
    "attach_artifact",
    "decline_task",
  ]);

  const Correlation = z
    .object({
      endpointId: z.string().min(1).optional(),
      channelId: z.string().min(1).optional(),
      replyToMessageId: z.string().min(1).optional(),
      chain: z.array(z.string().min(1)).optional(),
      threadId: z.string().min(1).optional(),
      tokenHash: z.string().min(1).optional(),
      externalConversationId: z.string().min(1).optional(),
    })
    .strict();

  const ResolutionPolicy = z.enum(["first_reply", "quorum", "all"]);
  type ResolutionPolicy = z.infer<typeof ResolutionPolicy>;

  const Quorum = z
    .object({
      expected: z.number().int().min(1),
      threshold: z.number().int().min(1),
    })
    .strict()
    .refine((quorum) => quorum.threshold <= quorum.expected, {
      message: "quorum threshold cannot exceed expected responder count",
    });
  type Quorum = z.infer<typeof Quorum>;

  const Reply = z
    .object({
      replyKey: z.string().min(1),
      responderId: z.string().min(1),
      messageId: z.string().min(1).optional(),
      receivedAt: EpochMs,
    })
    .strict();

  const RecordBase = z
    .object({
      id: z.string().min(1),
      ownerRef: OwnerRef,

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
      expiresAt: EpochMs,
      followUpWindow: z.number().int().nonnegative(),
      createdAt: EpochMs,
      updatedAt: EpochMs,
      resolvedAt: EpochMs.optional(),
      cancelledAt: EpochMs.optional(),
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

  const Record = RecordBase.superRefine(validateResolution);

  return Record;
})();

export const HistoricalApproval = (() => {
  const State = z.enum(["pending", "approved", "refused"]);

  const DecidedBy = z.enum(["owner", "deadline"]);

  const PromotionSubject = z
    .object({
      kind: z.literal("contact_promotion"),
      actorId: z.string().min(1),
    })
    .strict();

  const MergeSubject = z
    .object({
      kind: z.literal("endpoint_merge"),
      endpointId: z.string().min(1),
      fromActorId: z.string().min(1),
      toActorId: z.string().min(1),
    })
    .strict();

  const PersonMutationSubject = z
    .object({
      kind: z.literal("person_mutation"),
      personId: z.string().min(1),

      manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();

  const Subject = z.discriminatedUnion("kind", [
    PromotionSubject,
    MergeSubject,
    PersonMutationSubject,
  ]);

  const RecordBase = z
    .object({
      id: z.string().min(1),
      subject: Subject,

      requestedBy: z.literal("resident"),

      deadline: EpochMs,
      state: State,

      revision: z.number().int().nonnegative(),
      createdAt: EpochMs,
      updatedAt: EpochMs,
      decidedAt: EpochMs.optional(),
      decidedBy: DecidedBy.optional(),
    })
    .strict();

  const Record = RecordBase.superRefine((record, ctx) => {
    const settled = record.decidedBy !== undefined && record.decidedAt !== undefined;
    if (record.state !== "pending" && !settled) {
      ctx.addIssue({
        code: "custom",
        message: "a decided Approval must record its settlement (decidedBy and decidedAt)",
        path: ["decidedBy"],
      });
    }
    if (
      record.state === "pending" &&
      (record.decidedBy !== undefined || record.decidedAt !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a pending Approval cannot carry a settlement",
        path: ["decidedBy"],
      });
    }
    if (record.state === "approved" && record.decidedBy === "deadline") {
      ctx.addIssue({
        code: "custom",
        message: "a deadline can only refuse — approval always names the Owner",
        path: ["decidedBy"],
      });
    }
  });

  return Record;
})();

