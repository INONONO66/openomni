import { z } from "zod";
import { NamedError } from "../error/index.js";
import { EpochMs } from "../time.js";

/**
 * Lease — the ON-WHOSE-BEHALF primitive (conversation-and-message-io.md §3.5).
 * A bounded, non-transferable send right one worker delegation holds into
 * exactly one Conversation. The lease is the ONLY relaxation of worker
 * admission: a worker may reach an actor iff a live lease names that worker's
 * delegation chain and the target actor. It dies with the delegation
 * (settle/cancel/deadline) and with its conversation.
 */

export const State = z.enum(["live", "closed"]);
export type State = z.infer<typeof State>;

/** Recorded settlement of a close — closing is idempotent and keeps the first cause. */
export const ClosedBy = z.enum([
  "settled",
  "cancelled",
  "deadline",
  "conversation_revoked",
  "owner",
]);
export type ClosedBy = z.infer<typeof ClosedBy>;

/**
 * The carved allocation (§3.3): `maxOutbound` sends reserved out of the
 * conversation's own outbound cap at issuance — sum(live leases) plus the
 * conversation's spent count never exceeds the window's cap, so a lease
 * holds real bounded spend, never a reference to the owner's budget.
 */
export const Budget = z
  .object({
    maxOutbound: z.number().int().positive(),
    outboundUsed: z.number().int().nonnegative(),
  })
  .strict();
export type Budget = z.infer<typeof Budget>;

const RecordBase = z
  .object({
    id: z.string().min(1),
    /** Scope — exactly one conversation (§3.5). */
    conversationId: z.string().min(1),
    /** The worker delegation holding the lease — never an inline child of it. */
    holderDelegationId: z.string().min(1),
    /** The conversation's counterparty, denormalized at issuance for admission checks. */
    contactId: z.string().min(1),
    budget: Budget,
    /** min(conversation.expiresAt, delegation.deadline), fixed at issuance. */
    expiresAt: EpochMs,
    state: State,
    /** Optimistic-concurrency revision; every recorded transition advances it exactly once. */
    revision: z.number().int().nonnegative(),
    createdAt: EpochMs,
    updatedAt: EpochMs,
    closedAt: EpochMs.optional(),
    closedBy: ClosedBy.optional(),
  })
  .strict();

export const Record = RecordBase.superRefine((record, ctx) => {
  const settled = record.closedBy !== undefined && record.closedAt !== undefined;
  if (record.state === "closed" && !settled) {
    ctx.addIssue({
      code: "custom",
      message: "a closed Lease must record its settlement (closedBy and closedAt)",
      path: ["closedBy"],
    });
  }
  if (record.state === "live" && (record.closedBy !== undefined || record.closedAt !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "a live Lease cannot carry a settlement",
      path: ["closedBy"],
    });
  }
  if (record.budget.outboundUsed > record.budget.maxOutbound) {
    ctx.addIssue({
      code: "custom",
      message: "lease spend cannot exceed its carved allocation",
      path: ["budget"],
    });
  }
});
export type Record = z.infer<typeof Record>;

/** Issue-time input: everything derived (state, spend, revision, stamps) is fold/store-owned. */
export const Create = RecordBase.pick({
  id: true,
  conversationId: true,
  holderDelegationId: true,
  contactId: true,
  expiresAt: true,
}).extend({
  maxOutbound: z.number().int().positive(),
});
export type Create = z.infer<typeof Create>;

export const StoreErrorCode = z.enum([
  "adapter_absent",
  "duplicate",
  "not_found",
  "revision_conflict",
  /** Storage was busy at the transaction entry — nothing was written; retrying is the caller's decision. */
  "unavailable",
  /** The carve would push sum(live leases) + spent past the conversation's outbound cap. */
  "carve_exceeded",
  /** Issuance into a missing or closed conversation fails closed. */
  "conversation_closed",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCode>;

/**
 * Typed failure taxonomy for durable Lease persistence. A missing
 * sub-adapter is `adapter_absent` — durable writes fail closed, never
 * warn-and-return. Callers branch on `data.code`, never message text.
 */
export const StoreError = NamedError.create(
  "LeaseStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    leaseId: z.string().min(1).optional(),
  }),
);
export type StoreError = InstanceType<typeof StoreError>;
