import { Gateway, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

/**
 * Durable active-egress debit rows (#219, perimeter domain — gateway-design
 * §4). Append-only: one row per ADMITTED proactive send. `readState` folds the
 * window projection the pure budget evaluator consumes in a single query so the
 * gate reads counts + the cooldown clock without materializing rows. The write
 * shape is owned by the EgressBudgetStore; this adapter re-validates on read
 * across the persistence boundary.
 */
export function createSqliteEgressBudgetAdapter(
  db: Database,
): ProtocolStorage.EgressBudgetSubAdapter {
  return {
    record(row) {
      const parsed = Gateway.EgressDebitRow.parse(row);
      db.query(
        `INSERT INTO egress_debit (id, sender_id, target_actor_id, class, at, time_created)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(parsed.id, parsed.senderId, parsed.targetActorId, parsed.class, parsed.at, Date.now());
    },
    readState(senderId, targetActorId, windowStartAt) {
      const row = db
        .query(
          `SELECT
             COUNT(*) FILTER (WHERE at >= ?) AS count_in_window,
             COUNT(*) FILTER (WHERE at >= ? AND class = 'notify') AS notify_in_window,
             COUNT(*) FILTER (WHERE at >= ? AND class = 'converse') AS converse_in_window,
             MAX(at) AS last_send_at
           FROM egress_debit
           WHERE sender_id = ? AND target_actor_id = ?`,
        )
        .get(windowStartAt, windowStartAt, windowStartAt, senderId, targetActorId) as {
        count_in_window: number;
        notify_in_window: number;
        converse_in_window: number;
        last_send_at: number | null;
      } | null;
      return Gateway.EgressDebitState.parse({
        countInWindow: row?.count_in_window ?? 0,
        notifyInWindow: row?.notify_in_window ?? 0,
        converseInWindow: row?.converse_in_window ?? 0,
        ...(row?.last_send_at == null ? {} : { lastSendAt: row.last_send_at }),
      });
    },
  };
}
