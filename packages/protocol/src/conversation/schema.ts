import { z } from "zod";
import { NamedError } from "../error/index.js";
import { EpochMs } from "../time.js";
import { OwnerRef } from "../wait/schema.js";

/**
 * Conversation — the WITH-WHOM-NOW primitive (conversation-and-message-io.md
 * §3.4). A durable, bounded messaging window with exactly one counterparty
 * contact on exactly one endpoint. While a Conversation is open, sends inside
 * it carry their own send right (the cold-outreach budget gate does not
 * apply); every send debits the window's outbound cap. It is not authority
 * over the contact — closing it ends the right instantly.
 */

export const State = z.enum(["open", "closed"]);
export type State = z.infer<typeof State>;

/** Who opened the window — owner action, Resident judgment, or delegate(ask) auto-open. */
export const OpenedBy = z.enum(["owner", "resident", "delegate_ask"]);
export type OpenedBy = z.infer<typeof OpenedBy>;

/** Recorded settlement of a close — closing is idempotent and keeps the first cause. */
export const ClosedBy = z.enum(["owner", "expiry", "cap_breach", "dependency_revoked"]);
export type ClosedBy = z.infer<typeof ClosedBy>;

/**
 * Daily UTC minute-of-day blackout. A window may wrap midnight
 * (start > end). Outbound sends inside it are deferred (typed refusal, the
 * message is never lost — the caller retries after the window).
 */
export const QuietHours = z
  .object({
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
  })
  .strict();
export type QuietHours = z.infer<typeof QuietHours>;

/**
 * The window's bounds, fixed at open. `onInboundCapBreach` names the only
 * shipped breach behavior: inbound past the cap is demoted to evidence-only
 * treatment and the owner is woken once — the window itself stays open.
 */
export const Policy = z
  .object({
    expiresAt: EpochMs,
    maxOutbound: z.number().int().positive(),
    maxInbound: z.number().int().positive(),
    quietHours: QuietHours.optional(),
    onInboundCapBreach: z.literal("demote"),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

const RecordBase = z
  .object({
    id: z.string().min(1),
    /** The one counterparty (actor id). */
    contactId: z.string().min(1),
    /** Pinned at open: the single endpoint this window speaks through. */
    endpointId: z.string().min(1),
    /** The session (or work item) accountable for the window. */
    ownerRef: OwnerRef,
    openedBy: OpenedBy,
    policy: Policy,
    state: State,
    outboundUsed: z.number().int().nonnegative(),
    inboundUsed: z.number().int().nonnegative(),
    /** First inbound-cap crossing — set once; the owner wake keys off it. */
    inboundCapBreachedAt: EpochMs.optional(),
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
      message: "a closed Conversation must record its settlement (closedBy and closedAt)",
      path: ["closedBy"],
    });
  }
  if (record.state === "open" && (record.closedBy !== undefined || record.closedAt !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "an open Conversation cannot carry a settlement",
      path: ["closedBy"],
    });
  }
});
export type Record = z.infer<typeof Record>;

/** Open-time input: everything derived (state, counters, revision, stamps) is fold-owned. */
export const Create = RecordBase.pick({
  id: true,
  contactId: true,
  endpointId: true,
  ownerRef: true,
  openedBy: true,
  policy: true,
});
export type Create = z.infer<typeof Create>;

export const StoreErrorCode = z.enum([
  "adapter_absent",
  "duplicate",
  "not_found",
  "revision_conflict",
  /** Storage was busy at the transaction entry — nothing was written; retrying is the caller's decision. */
  "unavailable",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCode>;

/**
 * Typed failure taxonomy for durable Conversation persistence. A missing
 * sub-adapter is `adapter_absent` — durable writes fail closed, never
 * warn-and-return. Callers branch on `data.code`, never message text.
 */
export const StoreError = NamedError.create(
  "ConversationStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    conversationId: z.string().min(1).optional(),
  }),
);
export type StoreError = InstanceType<typeof StoreError>;
