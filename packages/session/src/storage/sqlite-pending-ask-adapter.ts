import type { Communication, Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

type PendingAskRow = {
  id: string;
  data: string;
  status: Communication.PendingAsk.Status;
  origin_session_id: string;
  endpoint_id: string | null;
  channel_id: string | null;
  external_message_id: string | null;
  reply_to_message_id: string | null;
  thread_id: string | null;
  token_hash: string | null;
  external_conversation_id: string | null;
  time_created: number;
};

export function createSqlitePendingAskAdapter(db: Database): ProtocolStorage.PendingAskSubAdapter {
  return {
    create(record) {
      insertOrReplace(db, record, false);
    },
    get(id) {
      const row = db.query("SELECT data FROM pending_ask WHERE id = ?").get(id) as {
        data: string;
      } | null;
      return row ? (JSON.parse(row.data) as Communication.PendingAsk.Record) : undefined;
    },
    list(status) {
      const rows =
        status && status.length > 0
          ? (db
              .query(
                `SELECT data FROM pending_ask
                 WHERE status IN (${status.map(() => "?").join(", ")})
                 ORDER BY time_created ASC`,
              )
              .all(...status) as Array<{ data: string }>)
          : (db.query("SELECT data FROM pending_ask ORDER BY time_created ASC").all() as Array<{
              data: string;
            }>);
      return rows.map((row) => JSON.parse(row.data) as Communication.PendingAsk.Record);
    },
    findByCorrelation(query) {
      const conditions: string[] = [];
      const params: string[] = [];
      add(conditions, params, "endpoint_id", query.endpointId);
      add(conditions, params, "channel_id", query.channelId);
      add(conditions, params, "external_message_id", query.externalMessageId);
      add(conditions, params, "reply_to_message_id", query.replyToMessageId);
      add(conditions, params, "thread_id", query.threadId);
      add(conditions, params, "token_hash", query.tokenHash);
      add(conditions, params, "external_conversation_id", query.externalConversationId);
      if (conditions.length === 0) return [];
      const rows = db
        .query(
          `SELECT data FROM pending_ask
           WHERE status IN ('open', 'ambiguous') AND ${conditions.join(" AND ")}
           ORDER BY time_created ASC`,
        )
        .all(...params) as Array<{ data: string }>;
      return rows.map((row) => JSON.parse(row.data) as Communication.PendingAsk.Record);
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

function add(conditions: string[], params: string[], column: keyof PendingAskRow, value?: string) {
  if (!value) return;
  conditions.push(`${column} = ?`);
  params.push(value);
}
