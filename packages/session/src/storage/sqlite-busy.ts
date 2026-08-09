/**
 * SQLITE_BUSY detection for decision-class store transaction entries (#510
 * review fix minor). bun:sqlite surfaces a busy database as a `SQLiteError`
 * (a plain `Error` subclass) with `code: "SQLITE_BUSY"`, `errno: 5`, and
 * message "database is locked" — pinned empirically against bun 1.x by
 * `packages/session/test/storage/sqlite-busy.test.ts`. Extended result codes
 * (SQLITE_BUSY_SNAPSHOT / SQLITE_BUSY_RECOVERY / SQLITE_BUSY_TIMEOUT) share
 * the "SQLITE_BUSY" prefix, so the predicate matches on the prefix instead
 * of strict equality.
 *
 * A busy error at BEGIN IMMEDIATE (or inside the transaction body) means the
 * write unit never committed — the wait/work-item stores map it to their
 * typed `unavailable` error so callers get a retriable taxonomy instead of a
 * raw driver error. Retrying is the CALLER's decision, mirroring the append
 * core's cas_conflict contract.
 */
export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}
