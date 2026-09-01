import type { WorkItem } from "../work-item/index.js";
import type { SettledStatus } from "./schema.js";

/**
 * The single owner of "how a delegation settlement closes a WorkItem
 * attempt" (docs/machines-and-delegation.md): completed is the driver's
 * success, failed its definite failure, cancelled the owner's withdrawal,
 * and every non-answer (delivery_failed, no_response, kernel interruption)
 * is `interrupted` — the attempt ended without the executor's verdict.
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
      return "succeeded";
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
