import { Communication, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import {
  addOptionalStringEqualityCondition,
  listSqliteJsonDataByStatus,
  parseSqliteJsonDataRow,
  parseSqliteJsonDataRows,
  type SqliteJsonDataRow,
} from "./sqlite-json-data";

// Parse-don't-cast on read (#585 fail-closed): a pending_interaction row feeds
// evaluatePendingInteractionScope, which returns {allowed:true} for
// WorkerComplete/ActorReply. A corrupt/tampered row that parsed unvalidated
// could bypass its status/expiry invariants (fail-open, same class as the
// worker_grant row fixed in #584). A row that fails its schema is now a loud
// typed defect, never a silently-trusted value. Matches wait/blacklist.
function decodeInteraction(data: string): Communication.PendingInteraction.Record {
  return Communication.PendingInteraction.Record.parse(JSON.parse(data));
}

export function createSqlitePendingInteractionAdapter(
  db: Database,
): ProtocolStorage.PendingInteractionSubAdapter {
  return {
    create(record) {
      insertOrReplace(db, record, false);
    },
    get(id) {
      const row = db
        .query("SELECT data FROM pending_interaction WHERE id = ?")
        .get(id) as SqliteJsonDataRow | null;
      return parseSqliteJsonDataRow<Communication.PendingInteraction.Record>(
        row,
        decodeInteraction,
      );
    },
    list(status) {
      return listSqliteJsonDataByStatus<Communication.PendingInteraction.Record>(
        db,
        "pending_interaction",
        status,
        decodeInteraction,
      );
    },
    findByCorrelation(query) {
      const conditions = ["endpoint_id = ?", "channel_id = ?"];
      const params = [query.endpointId, query.channelId];
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
      const rows = db
        .query(
          `SELECT data FROM pending_interaction
           WHERE status IN ('open', 'resolved', 'follow_up') AND ${conditions.join(" AND ")}
           ORDER BY time_created ASC`,
        )
        .all(...params) as SqliteJsonDataRow[];
      return parseSqliteJsonDataRows<Communication.PendingInteraction.Record>(
        rows,
        decodeInteraction,
      );
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
