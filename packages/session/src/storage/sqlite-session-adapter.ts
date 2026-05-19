import type { Database } from "bun:sqlite";
import type { SessionInfo } from "../session/info";
import type { Storage } from "./storage";

export function createSqliteSessionAdapter(db: Database): Storage.Adapter["session"] {
  return {
    get: (id: string): SessionInfo | undefined => {
      const row = db.query("SELECT data FROM session WHERE id = ?").get(id) as {
        data: string;
      } | null;
      return row ? (JSON.parse(row.data) as SessionInfo) : undefined;
    },

    set: (id: string, info: SessionInfo): void => {
      db.query(
        `INSERT INTO session (id, data, time_created, time_updated)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           time_created = excluded.time_created,
           time_updated = excluded.time_updated`,
      ).run(id, JSON.stringify(info), info.time.created, info.time.updated);
    },

    list: (): SessionInfo[] => {
      const rows = db.query("SELECT data FROM session").all() as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as SessionInfo);
    },

    remove: (id: string): boolean => {
      const result = db.query("DELETE FROM session WHERE id = ?").run(id);
      return result.changes > 0;
    },
  };
}
