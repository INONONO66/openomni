import type { EpochMs } from "../time.js";
import { Create, type DecidedBy, Record, type State } from "./schema.js";

/**
 * Pure Approval transitions (conversation-and-message-io.md §6). Every
 * function is clock-free (`at` is injected), returns a typed outcome instead
 * of throwing, and advances `revision` exactly once per recorded change —
 * the durable store maps each changed outcome to one fact append plus one
 * compare-and-set.
 */

export type DecideOutcome =
  | { readonly kind: "decided"; readonly record: Record }
  | { readonly kind: "unchanged"; readonly record: Record };

/**
 * Revision starts at 1: the approval.requested fact is seq 1 on the owner
 * stream (appended at expectedHead 0), so `ledger_head.head === revision`
 * from birth — the same binding the Conversation and Lease streams ship.
 */
export function request(create: Create, at: EpochMs): Record {
  const parsed = Create.parse(create);
  return Record.parse({
    id: parsed.id,
    subject: parsed.subject,
    requestedBy: "resident",
    deadline: parsed.deadline,
    state: "pending",
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * The Owner's answer. Deciding a settled request keeps the first recorded
 * settlement; an answer arriving at or past the deadline records the
 * deadline's refusal instead — the Owner cannot approve into the past
 * (fail-closed, §8.13).
 */
export function decide(
  record: Record,
  answer: "approved" | "refused",
  at: EpochMs,
): DecideOutcome {
  if (record.state !== "pending") return { kind: "unchanged", record };
  const overdue = at >= record.deadline;
  const state: State = overdue ? "refused" : answer;
  const decidedBy: DecidedBy = overdue ? "deadline" : "owner";
  return {
    kind: "decided",
    record: Record.parse({
      ...record,
      state,
      decidedBy,
      decidedAt: at,
      revision: record.revision + 1,
      updatedAt: at,
    }),
  };
}

/**
 * The consuming read (§8.13): what this request authorizes AT `at`. A pending
 * request past its deadline reads as refused without waiting for a recorded
 * settlement — unanswered IS refusal, lazily, exactly like lease expiry.
 */
export function decision(record: Record, at: EpochMs): State {
  if (record.state === "pending" && at >= record.deadline) return "refused";
  return record.state;
}
