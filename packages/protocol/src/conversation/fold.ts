import type { EpochMs } from "../time.js";
import { type ClosedBy, Create, type QuietHours, Record } from "./schema.js";

/**
 * Pure Conversation transitions. Every function is clock-free (`at` is
 * injected), returns a typed outcome instead of throwing, and advances
 * `revision` exactly once per recorded change — the durable store maps each
 * changed outcome to one fact append plus one compare-and-set.
 */

export type CloseOutcome =
  | { readonly kind: "closed"; readonly record: Record }
  | { readonly kind: "unchanged"; readonly record: Record };

export type OutboundRefusalReason = "closed" | "expired" | "outbound_cap" | "quiet_hours";

export type OutboundOutcome =
  | { readonly kind: "admitted"; readonly record: Record }
  | { readonly kind: "refused"; readonly reason: OutboundRefusalReason };

export type InboundOutcome =
  | { readonly kind: "recorded"; readonly record: Record }
  | { readonly kind: "cap_breached"; readonly record: Record }
  | { readonly kind: "already_breached"; readonly record: Record };

/**
 * Revision starts at 1: the conversation.opened fact is seq 1 on the owner
 * stream (appended at expectedHead 0), so `ledger_head.head === revision`
 * from birth — the same binding the Wait stream ships.
 */
export function open(create: Create, at: EpochMs): Record {
  return Record.parse({
    ...Create.parse(create),
    state: "open",
    outboundUsed: 0,
    inboundUsed: 0,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}

/** Idempotent: closing a closed window keeps the first recorded settlement. */
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

/** Minute-of-day membership with midnight wrap (start > end spans the day boundary). */
function inQuietHours(quietHours: QuietHours, at: EpochMs): boolean {
  const minute = Math.floor(at / 60_000) % 1440;
  const { startMinute, endMinute } = quietHours;
  if (startMinute <= endMinute) return minute >= startMinute && minute < endMinute;
  return minute >= startMinute || minute < endMinute;
}

/**
 * The conversational send right: one outbound debit per admitted send.
 * Refusals are typed and lossless — `quiet_hours` is a deferral, the others
 * report the window's own bounds.
 */
export function admitOutbound(record: Record, at: EpochMs): OutboundOutcome {
  if (record.state === "closed") return { kind: "refused", reason: "closed" };
  if (at >= record.policy.expiresAt) return { kind: "refused", reason: "expired" };
  if (record.outboundUsed >= record.policy.maxOutbound) {
    return { kind: "refused", reason: "outbound_cap" };
  }
  if (record.policy.quietHours !== undefined && inQuietHours(record.policy.quietHours, at)) {
    return { kind: "refused", reason: "quiet_hours" };
  }
  return {
    kind: "admitted",
    record: Record.parse({
      ...record,
      outboundUsed: record.outboundUsed + 1,
      revision: record.revision + 1,
      updatedAt: at,
    }),
  };
}

/**
 * Count an inbound message against the window. Crossing the cap does NOT
 * close the window (`onInboundCapBreach: demote`): the first crossing is
 * reported once — the router demotes that delivery to evidence-only and the
 * owner is woken off that single outcome — and later overflow is
 * `already_breached` (still counted, never re-announced).
 */
export function recordInbound(record: Record, at: EpochMs): InboundOutcome {
  const inboundUsed = record.inboundUsed + 1;
  const breached = inboundUsed > record.policy.maxInbound;
  const firstBreach = breached && record.inboundCapBreachedAt === undefined;
  const next = Record.parse({
    ...record,
    inboundUsed,
    ...(firstBreach ? { inboundCapBreachedAt: at } : {}),
    revision: record.revision + 1,
    updatedAt: at,
  });
  if (firstBreach) return { kind: "cap_breached", record: next };
  if (breached) return { kind: "already_breached", record: next };
  return { kind: "recorded", record: next };
}
