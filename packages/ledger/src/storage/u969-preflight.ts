import type { Database } from "bun:sqlite";
import { HistoricalApproval, HistoricalWait } from "./historical-request-format";
import { terminalComplete } from "./u967-projection";
import {
  historicalWaitFields,
  historicalMismatch,
  historicalDuplicateRows,
} from "./historical-projections";

export const REQUEST_MIGRATION = "0038_session_requests/migration.sql";

function historicalRowComplete(
  table: "wait" | "approval",
  row: { id: string; data: string; status: string },
  at: number,
): boolean {
  try {
    if (table === "wait") {
      const parsed = HistoricalWait.safeParse(JSON.parse(row.data));
      return (
        parsed.success &&
        parsed.data.id === row.id &&
        parsed.data.status === row.status &&
        parsed.data.status !== "open" &&
        terminalComplete(parsed.data) &&
        (parsed.data.resolvedAt === undefined ||
          at > parsed.data.resolvedAt + parsed.data.followUpWindow)
      );
    }
    const parsed = HistoricalApproval.safeParse(JSON.parse(row.data));
    return (
      parsed.success &&
      parsed.data.id === row.id &&
      parsed.data.state === row.status &&
      parsed.data.state !== "pending" &&
      parsed.data.revision > 0 &&
      parsed.data.decidedAt !== undefined &&
      parsed.data.decidedAt >= parsed.data.createdAt &&
      parsed.data.updatedAt >= parsed.data.decidedAt
    );
  } catch {
    return false;
  }
}

function historicalRequestBlockers(db: Database, table: "wait" | "approval", at: number): string[] {
  const blocked: string[] = [];
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
    return blocked;
  const rows = db
    .query<{ id: string; data: string; status: string }, []>(
      `SELECT id, data, status FROM ${table} ORDER BY id`,
    )
    .all();
  for (const row of rows) {
    if (!historicalRowComplete(table, row, at)) blocked.push(`${table}:${row.id}`);
  }
  const fields =
    table === "wait"
      ? historicalWaitFields
      : ([
          ["revision", "revision"],
          ["deadline", "deadline"],
          ["time_created", "createdAt"],
          ["time_updated", "updatedAt"],
        ] as const);
  const mismatch = historicalMismatch(fields, table === "wait");
  for (const row of db
    .query<{ id: string }, []>(`SELECT id FROM ${table}
      WHERE CASE WHEN json_valid(data) THEN (${mismatch.join(" OR ")}) ELSE 1 END`)
    .all()) {
    blocked.push(`${table}:${row.id}`);
  }
  for (const row of db.query<{ id: string }, []>(historicalDuplicateRows(table)).all()) {
    blocked.push(`${table}:${row.id}`);
  }
  return blocked;
}

/** Read-only before PRAGMAs, and repeated under the migration write lock. */
export function preflight969(db: Database, at: number): void {
  if (db.query("SELECT 1 FROM _migrations WHERE name = ?").get(REQUEST_MIGRATION)) return;
  const blocked: string[] = [];
  for (const table of ["wait", "approval"] as const) {
    for (const blocker of historicalRequestBlockers(db, table, at)) blocked.push(blocker);
  }
  // These retained L0 rows can still drive native execution. They are not
  // archival just because the standalone request tables are empty.
  for (const row of db
    .query<{ id: string; session_id: string }, []>(`SELECT id, session_id FROM alarm
      WHERE status NOT IN ('fired', 'cancelled')
        AND CASE WHEN json_valid(spec) THEN json_extract(spec, '$.kind') = 'message_deadline'
          ELSE 0 END
      ORDER BY id`)
    .all()) {
    blocked.push(`alarm:${row.id}:session:${row.session_id}`);
  }
  for (const row of db
    .query<{ id: string; session_id: string; parent_id: string }, []>(
      `SELECT inbox.id, inbox.session_id, session.parent_id FROM inbox
       JOIN session ON session.id = inbox.session_id
       WHERE inbox.status = 'pending' AND session.parent_id IS NOT NULL
         AND session.role IS NOT NULL ORDER BY inbox.id`,
    )
    .all()) {
    // The verified pre-cutover CHECK excludes request/reply action kinds, so
    // no pending native input can have a complete canonical request binding.
    blocked.push(`inbox:${row.id}:session:${row.session_id}:parent:${row.parent_id}`);
  }
  for (const row of db
    .query<{ id: string; session_id: string; parent_id: string }, []>(`
    SELECT turn.id, turn.session_id, session.parent_id FROM action turn
    JOIN session ON session.id = turn.session_id
    WHERE session.parent_id IS NOT NULL AND turn.kind = 'turn'
      AND ((json_extract(turn.intent, '$.phase') = 'intent'
        AND NOT EXISTS (SELECT 1 FROM action result WHERE result.id = json_extract(turn.intent, '$.resultId')))
        OR (json_extract(turn.effect, '$.phase') = 'terminal' AND json_extract(turn.effect, '$.kind') = 'waiting'
          AND NOT EXISTS (SELECT 1 FROM action later WHERE later.session_id = turn.session_id
            AND later.kind = 'turn' AND later.ordinal > turn.ordinal)))
    ORDER BY turn.id`)
    .all()) {
    blocked.push(`turn:${row.id}:session:${row.session_id}:parent:${row.parent_id}`);
  }
  if (blocked.length > 0)
    throw new Error(`unresolved_legacy_requests:${[...new Set(blocked)].join(",")}`);
}
