import type { Communication, Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

type PendingInteractionRow = {
  id: string;
  data: string;
  status: Communication.PendingInteraction.Status;
  endpoint_id: string;
  channel_id: string;
  reply_to_message_id: string | null;
  thread_id: string | null;
  token_hash: string | null;
  external_conversation_id: string | null;
  time_created: number;
};

export function createSqlitePendingInteractionAdapter(
  db: Database,
): ProtocolStorage.PendingInteractionSubAdapter {
  return {
    create(record) {
      insertOrReplace(db, record, false);
    },
    get(id) {
      const row = db.query("SELECT data FROM pending_interaction WHERE id = ?").get(id) as {
        data: string;
      } | null;
      return row ? (JSON.parse(row.data) as Communication.PendingInteraction.Record) : undefined;
    },
    list(status) {
      const rows =
        status && status.length > 0
          ? (db
              .query(
                `SELECT data FROM pending_interaction
                 WHERE status IN (${status.map(() => "?").join(", ")})
                 ORDER BY time_created ASC`,
              )
              .all(...status) as Array<{ data: string }>)
          : (db
              .query("SELECT data FROM pending_interaction ORDER BY time_created ASC")
              .all() as Array<{ data: string }>);
      return rows.map((row) => JSON.parse(row.data) as Communication.PendingInteraction.Record);
    },
    findByCorrelation(query) {
      const conditions = ["endpoint_id = ?", "channel_id = ?"];
      const params = [query.endpointId, query.channelId];
      add(conditions, params, "reply_to_message_id", query.replyToMessageId);
      add(conditions, params, "thread_id", query.threadId);
      add(conditions, params, "token_hash", query.tokenHash);
      add(conditions, params, "external_conversation_id", query.externalConversationId);
      const rows = db
        .query(
          `SELECT data FROM pending_interaction
           WHERE status IN ('open', 'resolved', 'follow_up') AND ${conditions.join(" AND ")}
           ORDER BY time_created ASC`,
        )
        .all(...params) as Array<{ data: string }>;
      return rows.map((row) => JSON.parse(row.data) as Communication.PendingInteraction.Record);
    },
    set(record) {
      insertOrReplace(db, record, true);
    },
    remove(id) {
      return db.query("DELETE FROM pending_interaction WHERE id = ?").run(id).changes > 0;
    },
  };
}

function insertOrReplace(
  db: Database,
  record: Communication.PendingInteraction.Record,
  replace: boolean,
): void {
  const sql = replace
    ? `INSERT INTO pending_interaction (
         id, worker_run_id, session_id, data, status, endpoint_id, channel_id,
         reply_to_message_id, thread_id, token_hash, external_conversation_id,
         expires_at, follow_up_until, time_created, time_updated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         status = excluded.status,
         endpoint_id = excluded.endpoint_id,
         channel_id = excluded.channel_id,
         reply_to_message_id = excluded.reply_to_message_id,
         thread_id = excluded.thread_id,
         token_hash = excluded.token_hash,
         external_conversation_id = excluded.external_conversation_id,
         expires_at = excluded.expires_at,
         follow_up_until = excluded.follow_up_until,
         time_updated = excluded.time_updated`
    : `INSERT INTO pending_interaction (
         id, worker_run_id, session_id, data, status, endpoint_id, channel_id,
         reply_to_message_id, thread_id, token_hash, external_conversation_id,
         expires_at, follow_up_until, time_created, time_updated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.query(sql).run(
    record.id,
    record.workerRunId,
    record.sessionId,
    JSON.stringify(record),
    record.status,
    record.endpointId,
    record.channelId,
    record.correlation.replyToMessageId ?? null,
    record.correlation.threadId ?? null,
    record.correlation.tokenHash ?? null,
    record.correlation.externalConversationId ?? null,
    record.expiresAt,
    followUpUntil(record),
    record.createdAt,
    record.updatedAt,
  );
}

function followUpUntil(record: Communication.PendingInteraction.Record): number | null {
  if (!record.resolvedAt) return null;
  return record.resolvedAt + record.followUpWindow;
}

function add(
  conditions: string[],
  params: string[],
  column: keyof PendingInteractionRow,
  value?: string,
) {
  if (!value) return;
  conditions.push(`${column} = ?`);
  params.push(value);
}
