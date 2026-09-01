import { z } from "zod";
import { NamedError } from "../error/index.js";
import { EpochMs } from "../time.js";

/**
 * Approval — the Owner's consent lane (conversation-and-message-io.md §6).
 * Contact promotion and cross-channel endpoint merging are explicit acts,
 * never inferred (§8.4): each rides a durable approval request the Owner
 * answers before its deadline. An unanswered request reads as refused —
 * fail-closed is the timeout default (§8.13).
 */

export const State = z.enum(["pending", "approved", "refused"]);
export type State = z.infer<typeof State>;

/** Who settled the request: the Owner's answer, or the deadline's refusal. */
export const DecidedBy = z.enum(["owner", "deadline"]);
export type DecidedBy = z.infer<typeof DecidedBy>;

/** Promotion names the provisional contact it registers (§3.1). */
const PromotionSubject = z
  .object({
    kind: z.literal("contact_promotion"),
    actorId: z.string().min(1),
  })
  .strict();

/**
 * A merge names the exact endpoint that moves and both identities — identity
 * is per-endpoint, and folding endpoints across channels into one contact is
 * the anti-spoofing act the Owner must see whole (§8.4).
 */
const MergeSubject = z
  .object({
    kind: z.literal("endpoint_merge"),
    endpointId: z.string().min(1),
    fromActorId: z.string().min(1),
    toActorId: z.string().min(1),
  })
  .strict();

/**
 * A Person-manifest mutation the Owner must see whole (provisioning §8.5/§8.6):
 * tier raises above collaborator and ANY change to the owner Person route
 * here. The digest pins the exact manifest the Owner approved — the act
 * executor recomputes it, so an edited manifest cannot ride an old consent.
 */
const PersonMutationSubject = z
  .object({
    kind: z.literal("person_mutation"),
    personId: z.string().min(1),
    /** sha256 hex of the canonical manifest JSON the Owner approved. */
    manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const Subject = z.discriminatedUnion("kind", [
  PromotionSubject,
  MergeSubject,
  PersonMutationSubject,
]);
export type Subject = z.infer<typeof Subject>;

const RecordBase = z
  .object({
    id: z.string().min(1),
    subject: Subject,
    /** The Resident is the only requester today; the field keeps the audit honest. */
    requestedBy: z.literal("resident"),
    /** Past this instant an undecided request reads as refused (fail-closed). */
    deadline: EpochMs,
    state: State,
    /** Optimistic-concurrency revision; every recorded transition advances it exactly once. */
    revision: z.number().int().nonnegative(),
    createdAt: EpochMs,
    updatedAt: EpochMs,
    decidedAt: EpochMs.optional(),
    decidedBy: DecidedBy.optional(),
  })
  .strict();

export const Record = RecordBase.superRefine((record, ctx) => {
  const settled = record.decidedBy !== undefined && record.decidedAt !== undefined;
  if (record.state !== "pending" && !settled) {
    ctx.addIssue({
      code: "custom",
      message: "a decided Approval must record its settlement (decidedBy and decidedAt)",
      path: ["decidedBy"],
    });
  }
  if (record.state === "pending" && (record.decidedBy !== undefined || record.decidedAt !== undefined)) {
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
export type Record = z.infer<typeof Record>;

/** Request-time input: state, revision, and stamps are fold/store-owned. */
export const Create = RecordBase.pick({
  id: true,
  subject: true,
  deadline: true,
});
export type Create = z.infer<typeof Create>;

export const StoreErrorCode = z.enum([
  "adapter_absent",
  "duplicate",
  "not_found",
  "revision_conflict",
  /** Storage was busy at the transaction entry — nothing was written; retrying is the caller's decision. */
  "unavailable",
  /** The pending-request volume bound refused the request (§8.13 approval-fatigue hold). */
  "request_flooded",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCode>;

/**
 * Typed failure taxonomy for durable Approval persistence. A missing
 * sub-adapter is `adapter_absent` — durable writes fail closed, never
 * warn-and-return. Callers branch on `data.code`, never message text.
 */
export const StoreError = NamedError.create(
  "ApprovalStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    approvalId: z.string().min(1).optional(),
  }),
);
export type StoreError = InstanceType<typeof StoreError>;
