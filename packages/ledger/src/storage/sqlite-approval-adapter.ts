import { Approval, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import { listSqliteJsonDataByStatus, type SqliteJsonDataRow } from "./sqlite-json-data";

/**
 * Durable Approval rows. Write shape is owned by the ApprovalStore
 * (`Approval.Record.parse` via the fold); this adapter records receipts
 * (`changes === 1`) and re-validates only on read, across the persistence
 * boundary — the same discipline as the conversation and lease adapters.
 */
export function createSqliteApprovalAdapter(db: Database): ProtocolStorage.ApprovalSubAdapter {
  return {
    create(record) {
      const result = db
        .query(
          `INSERT OR IGNORE INTO approval (
             id, data, revision, status, deadline, time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          JSON.stringify(record),
          record.revision,
          record.state,
          record.deadline,
          record.createdAt,
          record.updatedAt,
        );
      return result.changes === 1;
    },
    get(id) {
      const row = db.query("SELECT data FROM approval WHERE id = ?").get(id) as
        | SqliteJsonDataRow
        | null;
      return row ? decodeApprovalData(row.data) : undefined;
    },
    list(state) {
      return listSqliteJsonDataByStatus<Approval.Record>(db, "approval", state, decodeApprovalData);
    },
    countPendingSince(since) {
      const row = db
        .query(
          "SELECT COUNT(*) AS count FROM approval WHERE status = 'pending' AND time_created >= ?",
        )
        .get(since) as { count: number };
      return row.count;
    },
    compareAndSet(id, expectedRevision, record) {
      if (record.id !== id) {
        throw new Error(`Approval id mismatch: key=${id} payload=${record.id}`);
      }
      if (record.revision !== expectedRevision + 1) {
        throw new Error(
          `Approval revision must advance exactly once: expected=${expectedRevision} payload=${record.revision}`,
        );
      }
      const result = db
        .query(
          `UPDATE approval SET
             data = ?, revision = ?, status = ?, time_updated = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          JSON.stringify(record),
          record.revision,
          record.state,
          record.updatedAt,
          id,
          expectedRevision,
        );
      return result.changes === 1;
    },
  };
}

function decodeApprovalData(data: string): Approval.Record {
  return Approval.Record.parse(JSON.parse(data));
}
