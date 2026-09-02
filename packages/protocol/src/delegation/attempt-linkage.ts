import type { WorkItem } from "../work-item/index.js";
import type { SettledStatus } from "./schema.js";

/**
 * The single owner of "how a delegation settlement closes a WorkItem
 * attempt" (docs/machines-and-delegation.md): completed is the driver's
 * success, failed its definite failure, cancelled the owner's withdrawal,
 * and every non-answer (delivery_failed, no_response, kernel interruption)
 * is `interrupted` — the attempt ended without the executor's verdict.
 *
 * #807: only a `verified` settlement — one citing durably recorded checks —
 * closes the attempt as `succeeded`. `unverified` is its own outcome: the work
 * may well be done, but nothing confirmed it, so calling it either success or
 * failure would be a lie. `completed` survives in the fold for `ask`, which
 * carries no WorkItem attempt, so it stays unreachable here while keeping the
 * switch exhaustive over the terminal vocabulary.
 *
 * `sent` is excluded from the domain: only notify settles as sent, and a
 * notify carries no WorkItem attempt to close (assign is the only
 * WorkItem-bearing operation).
 */
export function settlementToAttemptOutcome(
  status: Exclude<SettledStatus, "sent">,
): WorkItem.AttemptOutcome {
  switch (status) {
    case "completed":
    case "verified":
      return "succeeded";
    case "unverified":
      return "unverified";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "delivery_failed":
    case "no_response":
    case "interrupted":
      return "interrupted";
  }
}
