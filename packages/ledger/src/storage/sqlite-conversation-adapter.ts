import { Conversation, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import { listSqliteJsonDataByStatus, type SqliteJsonDataRow } from "./sqlite-json-data";

/**
 * Durable Conversation rows. Write shape is owned by the ConversationStore
 * (`Conversation.Record.parse` via the fold); this adapter records receipts
 * (`changes === 1`) and re-validates only on read, across the persistence
 * boundary — the same discipline as the wait adapter.
 */
export function createSqliteConversationAdapter(
  db: Database,
): ProtocolStorage.ConversationSubAdapter {
  return {
    create(record) {
      const result = db
        .query(
          `INSERT OR IGNORE INTO conversation (
             id, contact_id, endpoint_id, owner_kind, owner_id, data, revision,
             status, expires_at, time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.contactId,
          record.endpointId,
          record.ownerRef.kind,
          record.ownerRef.id,
          JSON.stringify(record),
          record.revision,
          record.state,
          record.policy.expiresAt,
          record.createdAt,
          record.updatedAt,
        );
      return result.changes === 1;
    },
    get(id) {
      const row = db
        .query("SELECT data FROM conversation WHERE id = ?")
        .get(id) as SqliteJsonDataRow | null;
      return row ? decodeConversationData(row.data) : undefined;
    },
    list(state) {
      return listSqliteJsonDataByStatus<Conversation.Record>(
        db,
        "conversation",
        state,
        decodeConversationData,
      );
    },
    findOpenByEndpoint(endpointId) {
      const rows = db
        .query(
          `SELECT data FROM conversation
           WHERE endpoint_id = ? AND status = 'open'
           ORDER BY time_created ASC`,
        )
        .all(endpointId) as SqliteJsonDataRow[];
      return rows.map((row) => decodeConversationData(row.data));
    },
    compareAndSet(id, expectedRevision, record) {
      if (record.id !== id) {
        throw new Error(`Conversation id mismatch: key=${id} payload=${record.id}`);
      }
      if (record.revision !== expectedRevision + 1) {
        throw new Error(
          `Conversation revision must advance exactly once: expected=${expectedRevision} payload=${record.revision}`,
        );
      }
      const result = db
        .query(
          `UPDATE conversation SET
             data = ?, revision = ?, status = ?, time_updated = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(JSON.stringify(record), record.revision, record.state, record.updatedAt, id, expectedRevision);
      return result.changes === 1;
    },
  };
}

function decodeConversationData(data: string): Conversation.Record {
  return Conversation.Record.parse(JSON.parse(data));
}
