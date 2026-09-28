/**
 * Check 3 child writer: opens a per-session ledger sqlite file and attempts
 * ONE fenced append through OUR commit fence (commitSession lease_owner +
 * lease_fence + CAS revision). Prints exactly one JSON line to stdout:
 *   { ok: true, revision }            on a committed append
 *   { ok: false, reason }             on a refusal ("stale" | "revision" |
 *                                     "inbox") or any storage-level error
 *                                     (e.g. SQLITE_BUSY message text)
 * and exits 0 so the parent test can assert on the JSON, not the exit code.
 *
 * Usage: bun src/fence-child.ts <file> <sessionId> <owner> <fence> <expectedRevision>
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { appendTurnAction, openSessionDb } from "./session-file";

const Args = z.tuple([
  z.string().min(1), // file
  z.string().min(1), // sessionId
  z.string().min(1), // owner
  z.coerce.number().int().nonnegative(), // fence
  z.coerce.number().int().nonnegative(), // expectedRevision
]);

const RefusalReason = z.enum(["stale", "revision", "inbox"]);

/** Bun SQLiteError shape we care about: a string `code` like "SQLITE_BUSY". */
const SqliteBusyLike = z.object({ code: z.string().startsWith("SQLITE_BUSY") });

interface ChildOutput {
  readonly ok: boolean;
  readonly reason?: string;
  readonly revision?: number;
}

/**
 * The ledger bootstrap runs a schema preflight read BEFORE it applies
 * `PRAGMA busy_timeout = 5000` to the fresh connection, so a concurrent
 * writer can surface SQLITE_BUSY_RECOVERY instantly at open time. Mirror the
 * busy_timeout semantics ourselves: retry the open until the same 5000ms
 * deadline SQLite's own busy handler would honor.
 */
function openWithBusyRetry(file: string, timeoutMs: number): Database {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return openSessionDb(file);
    } catch (error) {
      if (!SqliteBusyLike.safeParse(error).success || Date.now() >= deadline) throw error;
      Bun.sleepSync(25);
    }
  }
}

function attempt(): ChildOutput {
  const [file, sessionId, owner, fence, expectedRevision] = Args.parse(process.argv.slice(2));
  let db: Database | undefined;
  try {
    db = openWithBusyRetry(file, 5000);
    const result = appendTurnAction(db, {
      sessionId,
      owner,
      fence,
      expectedRevision,
      payload: { text: `write by ${owner} at expectedRevision ${expectedRevision}` },
    });
    return { ok: true, revision: result.revision };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // appendTurnAction surfaces fence refusals as "commitSession refused (<reason>): ...".
    const match = /^commitSession refused \((\w+)\)/.exec(message);
    const parsed = match === null ? undefined : RefusalReason.safeParse(match[1]);
    if (parsed !== undefined && parsed.success) return { ok: false, reason: parsed.data };
    // Storage-level failure (e.g. SQLITE_BUSY): report code + raw message.
    const busy = SqliteBusyLike.safeParse(error);
    const reason = busy.success ? `${busy.data.code}: ${message}` : message;
    return { ok: false, reason };
  } finally {
    db?.close();
  }
}

console.log(JSON.stringify(attempt()));
