import type { Database } from "bun:sqlite";

export type SqliteJsonDataTable = "pending_ask" | "pending_interaction" | "wait";

export type SqliteStringEqualityColumn =
  | "endpoint_id"
  | "channel_id"
  | "external_message_id"
  | "reply_to_message_id"
  | "thread_id"
  | "token_hash"
  | "external_conversation_id";

export type SqliteJsonDataRow = {
  readonly data: string;
};

export function parseSqliteJsonDataRow<T>(row: SqliteJsonDataRow | null): T | undefined {
  if (!row) return undefined;
  return JSON.parse(row.data) as T;
}

export function parseSqliteJsonDataRows<T>(rows: readonly SqliteJsonDataRow[]): T[] {
  return rows.map((row) => JSON.parse(row.data) as T);
}

export function listSqliteJsonDataByStatus<T>(
  db: Database,
  table: SqliteJsonDataTable,
  status: readonly string[] | undefined,
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
  return parseSqliteJsonDataRows<T>(rows);
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
