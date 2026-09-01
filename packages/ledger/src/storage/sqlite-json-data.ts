import type { Database } from "bun:sqlite";
import { z } from "zod";

export type SqliteJsonDataTable = "wait" | "conversation" | "lease";

export type SqliteStringEqualityColumn =
  | "endpoint_id"
  | "channel_id"
  | "reply_to_message_id"
  | "thread_id"
  | "token_hash"
  | "external_conversation_id";

export type SqliteJsonDataRow = {
  readonly data: string;
};

// The one `SELECT data` row envelope, for adapters that zod-validate the
// envelope before decoding (low-volume registry/config tables — the
// streaming projection adapters deliberately cast instead).
export const SqliteJsonDataRowSchema = z.object({ data: z.string() });
export const SqliteJsonDataRowsSchema = z.array(SqliteJsonDataRowSchema);

// Parse-don't-cast on read: every caller passes a `decode` that re-validates
// the row's JSON across the persistence boundary (schema `.parse`), so a
// corrupt/tampered row is a loud typed defect and never a silently-trusted
// value. The blind `JSON.parse(...) as T` this replaced was the fail-open
// root cause fixed for worker_grant/message/part in #584.
function parseSqliteJsonDataRows<T>(
  rows: readonly SqliteJsonDataRow[],
  decode: (data: string) => T,
): T[] {
  return rows.map((row) => decode(row.data));
}

export function listSqliteJsonDataByStatus<T>(
  db: Database,
  table: SqliteJsonDataTable,
  status: readonly string[] | undefined,
  decode: (data: string) => T,
): T[] {
  const rows =
    status && status.length > 0
      ? (db
          .query(
            `SELECT data FROM ${table}
             WHERE status IN (${status.map(() => "?").join(", ")})
             ORDER BY time_created ASC`,
          )
          .all(...status) as SqliteJsonDataRow[])
      : (db
          .query(`SELECT data FROM ${table} ORDER BY time_created ASC`)
          .all() as SqliteJsonDataRow[]);
  return parseSqliteJsonDataRows<T>(rows, decode);
}

export function addOptionalStringEqualityCondition(
  conditions: string[],
  params: string[],
  column: SqliteStringEqualityColumn,
  value: string | undefined,
): void {
  if (!value) return;
  conditions.push(`${column} = ?`);
  params.push(value);
}
