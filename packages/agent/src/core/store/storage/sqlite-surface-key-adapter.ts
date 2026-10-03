import type { Database } from "bun:sqlite";
import { LedgerInvariant } from "../errors";
import type { Storage as ProtocolStorage } from "@openomni/protocol";

type SurfaceKeyAdapter = ProtocolStorage.SurfaceKeySubAdapter;

export function createSqliteSurfaceKeyAdapter(db: Database, now: () => number): SurfaceKeyAdapter {
  return {
    claim: (key: string, sessionId: string, expectedSessionId?: string): string => {
      const at = now();
      // Composable db.transaction (savepoint-nesting like every other
      // adapter) instead of a raw BEGIN IMMEDIATE, which threw when a caller
      // already held a transaction on this connection.
      return db
        .transaction(() => {
          if (expectedSessionId !== undefined) {
            db.query(
              `UPDATE surface_key
               SET session_id = ?, time_created = ?
               WHERE key = ? AND session_id = ?`,
            ).run(sessionId, at, key, expectedSessionId);
          }

          db.query(
            `INSERT OR IGNORE INTO surface_key (key, session_id, time_created)
             VALUES (?, ?, ?)`,
          ).run(key, sessionId, at);

          const row = db.query("SELECT session_id FROM surface_key WHERE key = ?").get(key) as {
            session_id: string;
          } | null;
          if (row === null) {
            // Impossible state: the INSERT OR IGNORE above ran inside this
            // same immediate transaction, so the key MUST exist here. Falling
            // back to the candidate sessionId would fabricate an ownership
            // answer.
            throw new LedgerInvariant({
              operation: "surfaceKey.claim",
              message: `surface_key row missing after INSERT OR IGNORE: ${key}`,
            });
          }
          return row.session_id;
        })
        .immediate();
    },

    lookup: (key: string): string | undefined => {
      const row = db.query("SELECT session_id FROM surface_key WHERE key = ?").get(key) as {
        session_id: string;
      } | null;
      return row?.session_id;
    },

    listBySession: (sessionId: string): string[] => {
      const rows = db
        .query("SELECT key FROM surface_key WHERE session_id = ?")
        .all(sessionId) as Array<{
        key: string;
      }>;
      return rows.map((r) => r.key);
    },
  };
}
