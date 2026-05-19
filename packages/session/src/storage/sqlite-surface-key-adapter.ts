import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";

type SurfaceKeyAdapter = NonNullable<Storage.Adapter["surfaceKey"]>;

export function createSqliteSurfaceKeyAdapter(db: Database): SurfaceKeyAdapter {
  return {
    register: (key: string, sessionId: string): void => {
      db.query(
        `INSERT INTO surface_key (key, session_id, time_created)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           session_id = excluded.session_id,
           time_created = excluded.time_created`,
      ).run(key, sessionId, Date.now());
    },

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
        db.exec("COMMIT");
        return row?.session_id ?? sessionId;
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

    delete: (key: string): void => {
      db.query("DELETE FROM surface_key WHERE key = ?").run(key);
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
