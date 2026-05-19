import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";

type BackgroundTaskAdapter = NonNullable<Storage.Adapter["backgroundTask"]>;
type BackgroundTaskRecord = { id: string; data: string; status: string; output?: string };

export function createSqliteBackgroundTaskAdapter(db: Database): BackgroundTaskAdapter {
  return {
    upsert: (
      id: string,
      status: string,
      parentSessionId: string,
      data: string,
      output?: string,
    ): void => {
      const now = Date.now();
      db.query(
        `INSERT INTO background_task (id, status, parent_session_id, data, output, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           data = excluded.data,
           output = COALESCE(excluded.output, background_task.output),
           time_updated = excluded.time_updated`,
      ).run(id, status, parentSessionId, data, output ?? null, now, now);
    },

    get: (id: string): Omit<BackgroundTaskRecord, "id"> | undefined => {
      const row = db
        .query("SELECT data, status, output FROM background_task WHERE id = ?")
        .get(id) as {
        data: string;
        status: string;
        output: string | null;
      } | null;
      if (!row) return undefined;
      return { data: row.data, status: row.status, output: row.output ?? undefined };
    },

    listByStatus: (...statuses: string[]): BackgroundTaskRecord[] => {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT id, data, status, output FROM background_task WHERE status IN (${placeholders})`,
        )
        .all(...statuses) as Array<{
        id: string;
        data: string;
        status: string;
        output: string | null;
      }>;
      return rows.map((r) => ({
        id: r.id,
        data: r.data,
        status: r.status,
        output: r.output ?? undefined,
      }));
    },

    delete: (id: string): void => {
      db.query("DELETE FROM background_task WHERE id = ?").run(id);
    },
  };
}
