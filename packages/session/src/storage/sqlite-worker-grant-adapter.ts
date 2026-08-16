import { Communication, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

// Parse-don't-cast on read (#authz fail-closed): a worker_grant row feeds an
// authorization verdict, so a row that fails its schema is a loud recording/
// corruption defect, never a silently-trusted value. Matches wait/blacklist.
function decodeGrant(data: string): Communication.WorkerGrant.Record {
  return Communication.WorkerGrant.Record.parse(JSON.parse(data));
}

export function createSqliteWorkerGrantAdapter(
  db: Database,
): ProtocolStorage.WorkerGrantSubAdapter {
  return {
    create(record) {
      insertOrReplace(db, record, false);
    },
    get(id) {
      const row = db.query("SELECT data FROM worker_grant WHERE id = ?").get(id) as {
        data: string;
      } | null;
      return row ? decodeGrant(row.data) : undefined;
    },
    list(workerRunId) {
      const rows = workerRunId
        ? (db
            .query(
              "SELECT data FROM worker_grant WHERE worker_run_id = ? ORDER BY time_created ASC",
            )
            .all(workerRunId) as Array<{ data: string }>)
        : (db.query("SELECT data FROM worker_grant ORDER BY time_created ASC").all() as Array<{
            data: string;
          }>);
      return rows.map((row) => decodeGrant(row.data));
    },
    set(record) {
      return insertOrReplace(db, record, true).changes === 1;
    },
    remove(id) {
      return db.query("DELETE FROM worker_grant WHERE id = ?").run(id).changes > 0;
    },
  };
}

function insertOrReplace(db: Database, record: Communication.WorkerGrant.Record, replace: boolean) {
  const sql = replace
    ? `INSERT INTO worker_grant (
         id, worker_run_id, data, status, version, time_created, time_updated, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         worker_run_id = excluded.worker_run_id,
         data = excluded.data,
         status = excluded.status,
         version = excluded.version,
         time_updated = excluded.time_updated,
         expires_at = excluded.expires_at
       WHERE excluded.version > worker_grant.version`
    : `INSERT INTO worker_grant (
         id, worker_run_id, data, status, version, time_created, time_updated, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  return db
    .query(sql)
    .run(
      record.id,
      record.workerRunId,
      JSON.stringify(record),
      record.status,
      record.version,
      record.createdAt,
      record.updatedAt,
      record.expiresAt ?? null,
    );
}
