import { CronJob, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

export function createSqliteCronJobAdapter(db: Database): ProtocolStorage.CronJobSubAdapter {
  return {
    get(id) {
      const row = db.query("SELECT data FROM cron_job WHERE id = ?").get(id) as {
        data: string;
      } | null;
      return row ? CronJob.Info.parse(JSON.parse(row.data)) : undefined;
    },
    set(job) {
      db.query(
        `INSERT INTO cron_job (id, data, time_created, time_updated)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           time_updated = excluded.time_updated`,
      ).run(job.id, JSON.stringify(job), job.createdAt, Date.now());
    },
    list() {
      const rows = db
        .query("SELECT data FROM cron_job ORDER BY time_created ASC, id ASC")
        .all() as Array<{
        data: string;
      }>;
      return rows.map((row) => CronJob.Info.parse(JSON.parse(row.data)));
    },
    remove(id) {
      return db.query("DELETE FROM cron_job WHERE id = ?").run(id).changes > 0;
    },
  };
}
