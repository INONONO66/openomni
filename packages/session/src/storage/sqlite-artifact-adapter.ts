import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";

type ArtifactAdapter = NonNullable<Storage.Adapter["artifact"]>;

export function createSqliteArtifactAdapter(db: Database): ArtifactAdapter {
  return {
    store: (id: string, sessionId: string, meta: string, content: string): void => {
      const now = Date.now();
      db.query(
        `INSERT INTO artifact (id, session_id, meta, content, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           meta = excluded.meta,
           content = excluded.content,
           time_updated = excluded.time_updated`,
      ).run(id, sessionId, meta, content, now, now);
    },

    get: (id: string): { meta: string; content: string; sessionId: string } | undefined => {
      const row = db
        .query("SELECT meta, content, session_id FROM artifact WHERE id = ?")
        .get(id) as {
        meta: string;
        content: string;
        session_id: string;
      } | null;
      if (!row) return undefined;
      return { meta: row.meta, content: row.content, sessionId: row.session_id };
    },

    list: (sessionId: string): Array<{ id: string; meta: string; content: string }> => {
      return db
        .query("SELECT id, meta, content FROM artifact WHERE session_id = ?")
        .all(sessionId) as Array<{
        id: string;
        meta: string;
        content: string;
      }>;
    },

    delete: (id: string): void => {
      db.query("DELETE FROM artifact WHERE id = ?").run(id);
    },
  };
}
