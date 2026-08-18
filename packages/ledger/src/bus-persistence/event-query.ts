import { EventVisibility, type EventRecord } from "./query-contracts.js";
import { getDatabase } from "./database.js";
import type { BusEventRow } from "./query-rows.js";

export function listErrors(sessionId: string): Promise<EventRecord[]> {
  const rows = getDatabase()
    .query(
      `SELECT * FROM bus_event
         WHERE session_id = ? AND event_type LIKE '%error%'
         ORDER BY time_created DESC`,
    )
    .all(sessionId) as BusEventRow[];
  return Promise.resolve(rows.map(toEventRecord));
}

// merged from event-record-mapper.ts (#453 hygiene: sub-30-LOC single-importer)
function toEventRecord(row: BusEventRow): EventRecord {
  if (row.session_id === null) {
    // Impossible for the session-scoped query above (WHERE session_id = ?);
    // sessionless chain rows must never be mapped into a session record.
    throw new Error(`bus_event row ${row.id} has no session_id — not a session event`);
  }
  return {
    id: String(row.id),
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    eventType: row.event_type,
    category: row.category,
    visibility: EventVisibility.parse(row.visibility),
    data: JSON.parse(row.data) as Record<string, unknown>,
    traceId: row.trace_id,
    durationMs: row.duration_ms ?? undefined,
    timeCreated: row.time_created,
  };
}
