import type { EpochMs } from "../time.js";
import { type ClosedBy, Create, Record } from "./schema.js";

/**
 * Pure Lease transitions. Every function is clock-free (`at` is injected),
 * returns a typed outcome instead of throwing, and advances `revision`
 * exactly once per recorded change — the durable store maps each changed
 * outcome to one fact append plus one compare-and-set.
 */

export type CloseOutcome =
  | { readonly kind: "closed"; readonly record: Record }
  | { readonly kind: "unchanged"; readonly record: Record };

export type DebitRefusalReason = "closed" | "expired" | "budget_exhausted";

export type DebitOutcome =
  | { readonly kind: "debited"; readonly record: Record }
  | { readonly kind: "refused"; readonly reason: DebitRefusalReason };

/**
 * Revision starts at 1: the lease.issued fact is seq 1 on the owner stream
 * (appended at expectedHead 0), so `ledger_head.head === revision` from
 * birth — the same binding the Conversation stream ships.
 */
export function issue(create: Create, at: EpochMs): Record {
  const parsed = Create.parse(create);
  return Record.parse({
    id: parsed.id,
    conversationId: parsed.conversationId,
    holderDelegationId: parsed.holderDelegationId,
    contactId: parsed.contactId,
    budget: { maxOutbound: parsed.maxOutbound, outboundUsed: 0 },
    expiresAt: parsed.expiresAt,
    state: "live",
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}

/** Idempotent: closing a closed lease keeps the first recorded settlement. */
export function close(record: Record, closedBy: ClosedBy, at: EpochMs): CloseOutcome {
  if (record.state === "closed") return { kind: "unchanged", record };
  return {
    kind: "closed",
    record: Record.parse({
      ...record,
      state: "closed",
      closedBy,
      closedAt: at,
      revision: record.revision + 1,
      updatedAt: at,
    }),
  };
}

/**
 * One outbound debit per admitted lease send. Refusals are typed and
 * lossless: a dead lease (`closed`), a lapsed one (`expired`, inclusive
 * bound), or a spent one (`budget_exhausted`) — the carved allocation is the
 * hard bound §8.1/§8.3 lean on.
 */
export function debit(record: Record, at: EpochMs): DebitOutcome {
  if (record.state === "closed") return { kind: "refused", reason: "closed" };
  if (at >= record.expiresAt) return { kind: "refused", reason: "expired" };
  if (record.budget.outboundUsed >= record.budget.maxOutbound) {
    return { kind: "refused", reason: "budget_exhausted" };
  }
  return {
    kind: "debited",
    record: Record.parse({
      ...record,
      budget: { ...record.budget, outboundUsed: record.budget.outboundUsed + 1 },
      revision: record.revision + 1,
      updatedAt: at,
    }),
  };
}
