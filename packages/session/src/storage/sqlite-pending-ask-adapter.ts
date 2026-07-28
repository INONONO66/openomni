import type { Communication, Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import {
  addOptionalStringEqualityCondition,
  listSqliteJsonDataByStatus,
  parseSqliteJsonDataRow,
  parseSqliteJsonDataRows,
  type SqliteJsonDataRow,
} from "./sqlite-json-data";

export function createSqlitePendingAskAdapter(db: Database): ProtocolStorage.PendingAskSubAdapter {
  return {
    create(record) {
      insertOrReplace(db, record, false);
    },
    get(id) {
      const row = db
        .query("SELECT data FROM pending_ask WHERE id = ?")
        .get(id) as SqliteJsonDataRow | null;
      return parseSqliteJsonDataRow<Communication.PendingAsk.Record>(row);
    },
    list(status) {
      return listSqliteJsonDataByStatus<Communication.PendingAsk.Record>(db, "pending_ask", status);
    },
    findByCorrelation(query) {
      const conditions: string[] = [];
      const params: string[] = [];
      addOptionalStringEqualityCondition(conditions, params, "endpoint_id", query.endpointId);
      addOptionalStringEqualityCondition(conditions, params, "channel_id", query.channelId);
      addOptionalStringEqualityCondition(
        conditions,
        params,
        "external_message_id",
        query.externalMessageId,
      );
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
      if (conditions.length === 0) return [];
      const rows = db
        .query(
          `SELECT data FROM pending_ask
           WHERE status IN ('open', 'ambiguous') AND ${conditions.join(" AND ")}
           ORDER BY time_created ASC`,
        )
        .all(...params) as SqliteJsonDataRow[];
      return parseSqliteJsonDataRows<Communication.PendingAsk.Record>(rows);
    },
    set(record) {
      insertOrReplace(db, record, true);
    },
    remove(id) {
      return db.query("DELETE FROM pending_ask WHERE id = ?").run(id).changes > 0;
    },
  };
}

function insertOrReplace(
  db: Database,
  record: Communication.PendingAsk.Record,
  replace: boolean,
): void {
  const sql = replace
    ? `INSERT INTO pending_ask (
         id, data, status, origin_session_id, endpoint_id, channel_id,
         external_message_id, reply_to_message_id, thread_id, token_hash,
         external_conversation_id, time_created, time_updated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         status = excluded.status,
         endpoint_id = excluded.endpoint_id,
         channel_id = excluded.channel_id,
         external_message_id = excluded.external_message_id,
         reply_to_message_id = excluded.reply_to_message_id,
         thread_id = excluded.thread_id,
         token_hash = excluded.token_hash,
         external_conversation_id = excluded.external_conversation_id,
         time_updated = excluded.time_updated`
    : `INSERT INTO pending_ask (
         id, data, status, origin_session_id, endpoint_id, channel_id,
         external_message_id, reply_to_message_id, thread_id, token_hash,
         external_conversation_id, time_created, time_updated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.query(sql).run(
    record.id,
    JSON.stringify(record),
    record.status,
    record.originSessionId,
    record.endpointId ?? null,
    record.channelId ?? null,
    record.correlation.externalMessageId ?? null,
    record.correlation.replyToMessageId ?? null,
    record.correlation.threadId ?? null,
    record.correlation.tokenHash ?? null,
    record.correlation.externalConversationId ?? null,
    record.createdAt,
    record.updatedAt,
  );
}
