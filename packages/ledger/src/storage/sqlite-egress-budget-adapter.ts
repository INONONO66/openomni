import { Gateway, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import { claimWithinCountedWindow } from "./counted-window-claim.js";
import { z } from "zod";
import { SqliteCount } from "./sqlite-json-data";

const WindowRow = z.object({
  count_in_window: SqliteCount,
  notify_in_window: SqliteCount,
  converse_in_window: SqliteCount,
  last_send_at: z.number().nullable(),
});
const ClaimRow = z.object({
  sender_id: z.string(),
  target_actor_id: z.string(),
  class: Gateway.EgressDebitRow.shape.class,
  at: z.number(),
});

/**
 * Durable active-egress counted-window claims (#219, perimeter domain —
 * gateway-design §4). The projection read and admitted-row append run under
 * one BEGIN IMMEDIATE so two connections cannot both consume the same
 * remaining slot. Append-only: one row per ADMITTED proactive send.
 */
export function createSqliteEgressBudgetAdapter(
  db: Database,
): ProtocolStorage.EgressBudgetSubAdapter {
  const read: ProtocolStorage.EgressBudgetSubAdapter["read"] = (
    senderId,
    targetActorId,
    windowStartAt,
  ) => {
    const state = WindowRow.parse(
      db
        .query(`SELECT
      COUNT(*) FILTER (WHERE at >= ?) AS count_in_window,
      COUNT(*) FILTER (WHERE at >= ? AND class = 'notify') AS notify_in_window,
      COUNT(*) FILTER (WHERE at >= ? AND class = 'converse') AS converse_in_window,
      MAX(at) AS last_send_at
      FROM egress_debit WHERE sender_id = ? AND target_actor_id = ?`)
        .get(windowStartAt, windowStartAt, windowStartAt, senderId, targetActorId),
    );
    return Gateway.EgressDebitState.parse({
      countInWindow: state.count_in_window,
      notifyInWindow: state.notify_in_window,
      converseInWindow: state.converse_in_window,
      ...(state.last_send_at === null ? {} : { lastSendAt: state.last_send_at }),
    });
  };
  return {
    read,
    claim(row, windowStartAt, canClaim) {
      const parsed = Gateway.EgressDebitRow.parse(row);
      return claimWithinCountedWindow({
        transaction: (operation) => db.transaction(operation).immediate(),
        alreadyClaimed: () => {
          const existing = ClaimRow.nullable().parse(
            db
              .query(
                `SELECT sender_id, target_actor_id, class, at
               FROM egress_debit
               WHERE id = ?`,
              )
              .get(parsed.id),
          );
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
        readWindowState: () => read(parsed.senderId, parsed.targetActorId, windowStartAt),
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
