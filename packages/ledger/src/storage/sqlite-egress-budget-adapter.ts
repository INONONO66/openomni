import { Gateway, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import { claimWithinCountedWindow } from "./counted-window-claim.js";

/**
 * Durable active-egress counted-window claims (#219, perimeter domain —
 * gateway-design §4). The projection read and admitted-row append run under
 * one BEGIN IMMEDIATE so two connections cannot both consume the same
 * remaining slot. Append-only: one row per ADMITTED proactive send.
 */
export function createSqliteEgressBudgetAdapter(
  db: Database,
): ProtocolStorage.EgressBudgetSubAdapter {
  return {
    claim(row, windowStartAt, canClaim) {
      const parsed = Gateway.EgressDebitRow.parse(row);
      return claimWithinCountedWindow({
        transaction: (operation) => db.transaction(operation).immediate(),
        alreadyClaimed: () => {
          const existing = db
            .query(
              `SELECT sender_id, target_actor_id, class, at
               FROM egress_debit
               WHERE id = ?`,
            )
            .get(parsed.id) as {
            sender_id: string;
            target_actor_id: string;
            class: string;
            at: number;
          } | null;
          if (existing === null) return false;
          if (
            existing.sender_id !== parsed.senderId ||
            existing.target_actor_id !== parsed.targetActorId ||
            existing.class !== parsed.class ||
            existing.at !== parsed.at
          ) {
            throw new Error(`egress debit id ${parsed.id} already identifies a different claim`);
          }
          return true;
        },
        readWindowState: () => {
          const state = db
            .query(
              `SELECT
                 COUNT(*) FILTER (WHERE at >= ?) AS count_in_window,
                 COUNT(*) FILTER (WHERE at >= ? AND class = 'notify') AS notify_in_window,
                 COUNT(*) FILTER (WHERE at >= ? AND class = 'converse') AS converse_in_window,
                 MAX(at) AS last_send_at
               FROM egress_debit
               WHERE sender_id = ? AND target_actor_id = ?`,
            )
            .get(
              windowStartAt,
              windowStartAt,
              windowStartAt,
              parsed.senderId,
              parsed.targetActorId,
            ) as {
            count_in_window: number;
            notify_in_window: number;
            converse_in_window: number;
            last_send_at: number | null;
          } | null;
          return Gateway.EgressDebitState.parse({
            countInWindow: state?.count_in_window ?? 0,
            notifyInWindow: state?.notify_in_window ?? 0,
            converseInWindow: state?.converse_in_window ?? 0,
            ...(state?.last_send_at == null ? {} : { lastSendAt: state.last_send_at }),
          });
        },
        canClaim,
        append: () => {
          db.query(
            `INSERT INTO egress_debit (id, sender_id, target_actor_id, class, at, time_created)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            parsed.id,
            parsed.senderId,
            parsed.targetActorId,
            parsed.class,
            parsed.at,
            Date.now(),
          );
        },
      });
    },
  };
}
