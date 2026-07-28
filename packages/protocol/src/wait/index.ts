import { z } from "zod";
import { Ledger } from "../ledger/index.js";

const NonEmpty = z.string().min(1);
const Digest = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 digest");

export namespace Wait {
  export const OwnerRefV1 = z.discriminatedUnion("kind", [
    z
      .object({
        version: z.literal("wait-owner-ref-v1"),
        kind: z.literal("workItem"),
        id: NonEmpty,
      })
      .strict(),
    z
      .object({ version: z.literal("wait-owner-ref-v1"), kind: z.literal("session"), id: NonEmpty })
      .strict(),
  ]);
  export type OwnerRefV1 = z.infer<typeof OwnerRefV1>;

  export const ResponderRefV1 = z
    .object({
      version: z.literal("wait-responder-ref-v1"),
      actorId: NonEmpty,
      endpointId: NonEmpty.optional(),
    })
    .strict();
  export type ResponderRefV1 = z.infer<typeof ResponderRefV1>;

  export const CorrelationV1 = z
    .object({
      version: z.literal("wait-correlation-v1"),
      tokenHash: Digest.optional(),
      threadId: NonEmpty.optional(),
      replyToMessageId: NonEmpty.optional(),
      externalConversationId: NonEmpty.optional(),
    })
    .strict()
    .refine(
      (correlation) =>
        correlation.tokenHash !== undefined ||
        correlation.threadId !== undefined ||
        correlation.replyToMessageId !== undefined ||
        correlation.externalConversationId !== undefined,
      { message: "at least one correlation field is required" },
    );
  export type CorrelationV1 = z.infer<typeof CorrelationV1>;

  export const QuorumV1 = z
    .object({
      version: z.literal("wait-quorum-v1"),
      required: z.number().int().positive(),
      total: z.number().int().positive(),
    })
    .strict()
    .refine((quorum) => quorum.required <= quorum.total, {
      message: "quorum required count cannot exceed total responders",
      path: ["required"],
    });
  export type QuorumV1 = z.infer<typeof QuorumV1>;

  export const AllowedActionV1 = z.enum([
    "report_result",
    "ask_clarification",
    "attach_artifact",
    "decline_task",
  ]);
  export type AllowedActionV1 = z.infer<typeof AllowedActionV1>;

  export const OpenedV1 = z
    .object({
      version: z.literal("wait.opened.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      expectedResponders: z.array(ResponderRefV1).min(1),
      targetActorId: NonEmpty.optional(),
      endpointId: NonEmpty.optional(),
      channelId: NonEmpty.optional(),
      correlation: CorrelationV1,
      allowedActions: z.array(AllowedActionV1).min(1),
      resolutionPolicy: NonEmpty,
      quorum: QuorumV1,
      status: z.literal("open"),
      deadline: z.number().int().nonnegative(),
      partial: z.literal(false),
      followUpWindow: z.number().int().nonnegative(),
      attempt: Ledger.AttemptRefV1.optional(),
    })
    .strict()
    .superRefine((opened, ctx) => {
      const responderKeys = opened.expectedResponders.map(
        (ref) => `${ref.actorId}\0${ref.endpointId ?? ""}`,
      );
      if (new Set(responderKeys).size !== responderKeys.length) {
        ctx.addIssue({
          code: "custom",
          message: "expected responders must be unique",
          path: ["expectedResponders"],
        });
      }
      if (opened.quorum.total !== opened.expectedResponders.length) {
        ctx.addIssue({
          code: "custom",
          message: "quorum total must equal expected responder count",
          path: ["quorum", "total"],
        });
      }
      if (new Set(opened.allowedActions).size !== opened.allowedActions.length) {
        ctx.addIssue({
          code: "custom",
          message: "allowed actions must be unique",
          path: ["allowedActions"],
        });
      }
      if (
        opened.ownerRef.kind === "workItem" &&
        opened.attempt !== undefined &&
        opened.ownerRef.id !== opened.attempt.workItemId
      ) {
        ctx.addIssue({
          code: "custom",
          message: "work-item wait owner must match attempt work item",
          path: ["attempt", "workItemId"],
        });
      }
    });
  export type OpenedV1 = z.infer<typeof OpenedV1>;

  export const ResponseRecordedV1 = z
    .object({
      version: z.literal("wait.response_recorded.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      responder: ResponderRefV1,
      transportId: NonEmpty,
      responseHash: Digest,
      action: AllowedActionV1,
      payloadRef: NonEmpty,
      recordedAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  export type ResponseRecordedV1 = z.infer<typeof ResponseRecordedV1>;

  export const ResolvedV1 = z
    .object({
      version: z.literal("wait.resolved.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      responseEventIds: z.array(NonEmpty).min(1),
      quorum: QuorumV1,
      partial: z.boolean(),
      resolvedAtDbMs: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((resolved, ctx) => {
      const count = new Set(resolved.responseEventIds).size;
      if (count !== resolved.responseEventIds.length) {
        ctx.addIssue({
          code: "custom",
          message: "response event IDs must be unique",
          path: ["responseEventIds"],
        });
      }
      if (!resolved.partial && count < resolved.quorum.required) {
        ctx.addIssue({
          code: "custom",
          message: "non-partial resolution requires quorum",
          path: ["responseEventIds"],
        });
      }
      if (resolved.partial && count >= resolved.quorum.required) {
        ctx.addIssue({
          code: "custom",
          message: "partial resolution must remain below quorum",
          path: ["responseEventIds"],
        });
      }
      if (count > resolved.quorum.total) {
        ctx.addIssue({
          code: "custom",
          message: "response count cannot exceed quorum total",
          path: ["responseEventIds"],
        });
      }
    });
  export type ResolvedV1 = z.infer<typeof ResolvedV1>;

  export const ExpiredV1 = z
    .object({
      version: z.literal("wait.expired.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      expiredAtDbMs: z.number().int().nonnegative(),
      responseEventIds: z.array(NonEmpty).refine((refs) => new Set(refs).size === refs.length, {
        message: "response event IDs must be unique",
      }),
      partial: z.boolean(),
    })
    .strict();
  export type ExpiredV1 = z.infer<typeof ExpiredV1>;

  export const CancelledV1 = z
    .object({
      version: z.literal("wait.cancelled.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      cancelledAtDbMs: z.number().int().nonnegative(),
      reason: NonEmpty,
    })
    .strict();
  export type CancelledV1 = z.infer<typeof CancelledV1>;

  export const AmbiguityRecordedV1 = z
    .object({
      version: z.literal("wait.ambiguity_recorded.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      candidateWaitIds: z.array(NonEmpty).min(2),
      transportId: NonEmpty,
      responseHash: Digest,
      recordedAtDbMs: z.number().int().nonnegative(),
    })
    .strict()
    .refine((event) => new Set(event.candidateWaitIds).size === event.candidateWaitIds.length, {
      message: "ambiguity candidates must be unique",
      path: ["candidateWaitIds"],
    });
  export type AmbiguityRecordedV1 = z.infer<typeof AmbiguityRecordedV1>;

  export const AmbiguitySelectedV1 = z
    .object({
      version: z.literal("wait.ambiguity_selected.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      ambiguityEventId: NonEmpty,
      selectedWaitId: NonEmpty,
      selectedAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  export type AmbiguitySelectedV1 = z.infer<typeof AmbiguitySelectedV1>;

  export const ResponseSelectedV1 = z
    .object({
      version: z.literal("wait.response_selected.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      responseEventId: NonEmpty,
      selectedByPrincipalId: NonEmpty,
      selectedAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  export type ResponseSelectedV1 = z.infer<typeof ResponseSelectedV1>;

  export const FollowUpRecordedV1 = z
    .object({
      version: z.literal("wait.follow_up_recorded.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      responder: ResponderRefV1,
      transportId: NonEmpty,
      responseHash: Digest,
      payloadRef: NonEmpty,
      recordedAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  export type FollowUpRecordedV1 = z.infer<typeof FollowUpRecordedV1>;

  export const ReminderRequestedV1 = z
    .object({
      version: z.literal("wait.reminder_requested.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      responder: ResponderRefV1,
      reminderOrdinal: z.number().int().positive(),
      requestedAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  export type ReminderRequestedV1 = z.infer<typeof ReminderRequestedV1>;

  export const ResumeRequestedV1 = z
    .object({
      version: z.literal("wait.resume_requested.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      attempt: Ledger.AttemptRefV1,
      responseEventIds: z
        .array(NonEmpty)
        .min(1)
        .refine((refs) => new Set(refs).size === refs.length, {
          message: "response event IDs must be unique",
        }),
      requestedAtDbMs: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((event, ctx) => {
      if (event.ownerRef.kind === "workItem" && event.ownerRef.id !== event.attempt.workItemId) {
        ctx.addIssue({
          code: "custom",
          message: "work-item wait owner must match attempt work item",
          path: ["attempt", "workItemId"],
        });
      }
    });
  export type ResumeRequestedV1 = z.infer<typeof ResumeRequestedV1>;

  export const FollowUpWindowClosedV1 = z
    .object({
      version: z.literal("wait.follow_up_window_closed.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      followUpEventIds: z.array(NonEmpty).refine((refs) => new Set(refs).size === refs.length, {
        message: "follow-up event IDs must be unique",
      }),
      closedAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  export type FollowUpWindowClosedV1 = z.infer<typeof FollowUpWindowClosedV1>;

  export const PartialDeadlineV1 = z
    .object({
      version: z.literal("wait.partial_deadline.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      responseEventIds: z.array(NonEmpty).min(1),
      quorum: QuorumV1,
      observedAtDbMs: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((event, ctx) => {
      const uniqueCount = new Set(event.responseEventIds).size;
      if (uniqueCount !== event.responseEventIds.length) {
        ctx.addIssue({
          code: "custom",
          message: "response event IDs must be unique",
          path: ["responseEventIds"],
        });
      }
      if (uniqueCount >= event.quorum.required) {
        ctx.addIssue({
          code: "custom",
          message: "partial deadline must remain below quorum",
          path: ["responseEventIds"],
        });
      }
    });
  export type PartialDeadlineV1 = z.infer<typeof PartialDeadlineV1>;

  export const LateRejectedV1 = z
    .object({
      version: z.literal("wait.late_rejected.v1"),
      waitId: NonEmpty,
      ownerRef: OwnerRefV1,
      transportId: NonEmpty,
      responseHash: Digest,
      terminalEventId: NonEmpty,
      rejectedAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  export type LateRejectedV1 = z.infer<typeof LateRejectedV1>;

  export const StatusV1 = z.enum(["open", "resolved", "expired", "cancelled"]);
  export type StatusV1 = z.infer<typeof StatusV1>;

  export const LifecycleEventV1 = z.union([
    OpenedV1,
    ResponseRecordedV1,
    ResponseSelectedV1,
    ResolvedV1,
    ExpiredV1,
    CancelledV1,
    AmbiguityRecordedV1,
    AmbiguitySelectedV1,
    FollowUpRecordedV1,
    ReminderRequestedV1,
    ResumeRequestedV1,
    FollowUpWindowClosedV1,
    PartialDeadlineV1,
    LateRejectedV1,
  ]);
  export type LifecycleEventV1 = z.infer<typeof LifecycleEventV1>;
}
