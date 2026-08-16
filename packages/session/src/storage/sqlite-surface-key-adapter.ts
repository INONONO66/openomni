import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";

type SurfaceKeyAdapter = NonNullable<Storage.Adapter["surfaceKey"]>;

export function createSqliteSurfaceKeyAdapter(db: Database): SurfaceKeyAdapter {
  return {
    claim: (key: string, sessionId: string, expectedSessionId?: string): string => {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        if (expectedSessionId !== undefined) {
          db.query(
            `UPDATE surface_key
             SET session_id = ?, time_created = ?
             WHERE key = ? AND session_id = ?`,
          ).run(sessionId, now, key, expectedSessionId);
        }

        db.query(
          `INSERT OR IGNORE INTO surface_key (key, session_id, time_created)
           VALUES (?, ?, ?)`,
        ).run(key, sessionId, now);

        const row = db.query("SELECT session_id FROM surface_key WHERE key = ?").get(key) as {
          session_id: string;
        } | null;
        if (row === null) {
          // Impossible state: the INSERT OR IGNORE above ran inside this same
          // immediate transaction, so the key MUST exist here. Falling back to
          // the candidate sessionId would fabricate an ownership answer.
          throw new Error(`surface_key row missing after INSERT OR IGNORE: ${key}`);
        }
        db.exec("COMMIT");
        return row.session_id;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch (_rollbackErr) {
          void _rollbackErr;
        }
        throw err;
      }
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
