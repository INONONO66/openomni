import { Lease, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import { listSqliteJsonDataByStatus, type SqliteJsonDataRow } from "./sqlite-json-data";

/**
 * Durable Lease rows. Write shape is owned by the LeaseStore
 * (`Lease.Record.parse` via the fold); this adapter records receipts
 * (`changes === 1`) and re-validates only on read, across the persistence
 * boundary — the same discipline as the conversation adapter.
 */
export function createSqliteLeaseAdapter(db: Database): ProtocolStorage.LeaseSubAdapter {
  return {
    create(record) {
      const result = db
        .query(
          `INSERT OR IGNORE INTO lease (
             id, conversation_id, holder_delegation_id, contact_id, data,
             revision, status, expires_at, time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.conversationId,
          record.holderDelegationId,
          record.contactId,
          JSON.stringify(record),
          record.revision,
          record.state,
          record.expiresAt,
          record.createdAt,
          record.updatedAt,
        );
      return result.changes === 1;
    },
    get(id) {
      const row = db.query("SELECT data FROM lease WHERE id = ?").get(id) as
        | SqliteJsonDataRow
        | null;
      return row ? decodeLeaseData(row.data) : undefined;
    },
    list(state) {
      return listSqliteJsonDataByStatus<Lease.Record>(db, "lease", state, decodeLeaseData);
    },
    listLiveByConversation(conversationId, now) {
      const rows = db
        .query(
          "SELECT data FROM lease WHERE conversation_id = ? AND status = 'live' AND expires_at > ? ORDER BY time_created ASC")
        .all(conversationId, now) as SqliteJsonDataRow[];
      return rows.map((row) => decodeLeaseData(row.data));
    },
    listLiveByHolder(holderDelegationId, now) {
      const rows = db
        .query(
          "SELECT data FROM lease WHERE holder_delegation_id = ? AND status = 'live' AND expires_at > ? ORDER BY time_created ASC")
        .all(holderDelegationId, now) as SqliteJsonDataRow[];
      return rows.map((row) => decodeLeaseData(row.data));
    },
    compareAndSet(id, expectedRevision, record) {
      if (record.id !== id) {
        throw new Error(`Lease id mismatch: key=${id} payload=${record.id}`);
      }
      if (record.revision !== expectedRevision + 1) {
        throw new Error(
          `Lease revision must advance exactly once: expected=${expectedRevision} payload=${record.revision}`,
        );
      }
      const result = db
        .query(
          `UPDATE lease SET
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

function decodeLeaseData(data: string): Lease.Record {
  return Lease.Record.parse(JSON.parse(data));
}
