import { Wait, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import {
  addOptionalStringEqualityCondition,
  listSqliteJsonDataByStatus,
  type SqliteJsonDataRow,
} from "./sqlite-json-data";

/**
 * Durable Wait rows (#215). Write shape is owned by the WaitStore factory
 * (`Wait.Record.parse`); this adapter records receipts (`changes === 1`) and
 * re-validates only on read, across the persistence boundary.
 */
export function createSqliteWaitAdapter(db: Database): ProtocolStorage.WaitSubAdapter {
  return {
    create(record) {
      const result = db
        .query(
          `INSERT OR IGNORE INTO wait (
             id, owner_kind, owner_id, origin_message_id, data, revision, status,
             partial, endpoint_id, channel_id, reply_to_message_id, thread_id,
             token_hash, external_conversation_id, expires_at, follow_up_until,
             time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.ownerRef.kind,
          record.ownerRef.id,
          record.originMessageId,
          JSON.stringify(record),
          record.revision,
          record.status,
          record.partial ? 1 : 0,
          record.correlation.endpointId ?? null,
          record.correlation.channelId ?? null,
          record.correlation.replyToMessageId ?? null,
          record.correlation.threadId ?? null,
          record.correlation.tokenHash ?? null,
          record.correlation.externalConversationId ?? null,
          record.expiresAt,
          followUpUntil(record),
          record.createdAt,
          record.updatedAt,
        );
      return result.changes === 1;
    },
    get(id) {
      const row = db
        .query("SELECT data FROM wait WHERE id = ?")
        .get(id) as SqliteJsonDataRow | null;
      return row ? decodeWaitRow(row) : undefined;
    },
    list(status) {
      return listSqliteJsonDataByStatus<Wait.Record>(db, "wait", status, decodeWaitData);
    },
    findByCorrelation(query) {
      const conditions: string[] = [];
      const params: string[] = [];
      addOptionalStringEqualityCondition(conditions, params, "endpoint_id", query.endpointId);
      addOptionalStringEqualityCondition(conditions, params, "channel_id", query.channelId);
      addOptionalStringEqualityCondition(
        conditions,
        params,
        "reply_to_message_id",
        query.replyToMessageId,
      );
      addOptionalStringEqualityCondition(conditions, params, "thread_id", query.threadId);
      addOptionalStringEqualityCondition(conditions, params, "token_hash", query.tokenHash);
      addOptionalStringEqualityCondition(
        conditions,
        params,
        "external_conversation_id",
        query.externalConversationId,
      );
      if (conditions.length === 0) {
        // Fail closed: a query with no correlation field would otherwise be a
        // SQL syntax error today and an unbounded match over every live wait
        // if the WHERE clause were ever restructured.
        throw new Error("Wait correlation query must carry at least one correlation field");
      }
      const rows = db
        .query(
          `SELECT data FROM wait
           WHERE status IN ('open', 'resolved') AND ${conditions.join(" AND ")}
           ORDER BY time_created ASC`,
        )
        .all(...params) as SqliteJsonDataRow[];
      return rows.map(decodeWaitRow);
    },
    compareAndSet(id, expectedRevision, record) {
      if (record.id !== id) {
        throw new Error(`Wait id mismatch: key=${id} payload=${record.id}`);
      }
      if (record.revision !== expectedRevision + 1) {
        throw new Error(
          `Wait revision must advance exactly once: expected=${expectedRevision} payload=${record.revision}`,
        );
      }
      // Correlation projection columns move with the record: the
      // recordDeliveryReceipt transition re-keys reply_to_message_id to the
      // platform message id, and findByCorrelation reads these columns.
      const result = db
        .query(
          `UPDATE wait SET
             data = ?,
             revision = ?,
             status = ?,
             partial = ?,
             endpoint_id = ?,
             channel_id = ?,
             reply_to_message_id = ?,
             thread_id = ?,
             token_hash = ?,
             external_conversation_id = ?,
             follow_up_until = ?,
             time_updated = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          JSON.stringify(record),
          record.revision,
          record.status,
          record.partial ? 1 : 0,
          record.correlation.endpointId ?? null,
          record.correlation.channelId ?? null,
          record.correlation.replyToMessageId ?? null,
          record.correlation.threadId ?? null,
          record.correlation.tokenHash ?? null,
          record.correlation.externalConversationId ?? null,
          followUpUntil(record),
          record.updatedAt,
          id,
          expectedRevision,
        );
      return result.changes === 1;
    },
  };
}

function decodeWaitData(data: string): Wait.Record {
  return Wait.Record.parse(JSON.parse(data));
}

function decodeWaitRow(row: SqliteJsonDataRow): Wait.Record {
  return decodeWaitData(row.data);
}

function followUpUntil(record: Wait.Record): number | null {
  if (record.resolvedAt === undefined) return null;
  return record.resolvedAt + record.followUpWindow;
}
