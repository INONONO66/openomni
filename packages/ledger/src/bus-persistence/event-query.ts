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
    .all(sessionId) as Array<BusEventRow & { session_id: string }>;
  return Promise.resolve(rows.map(toEventRecord));
}

function toEventRecord(row: BusEventRow & { session_id: string }): EventRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    eventType: row.event_type,
    category: row.category,
    visibility: EventVisibility.parse(row.visibility),
    data: JSON.parse(row.data) as Record<string, unknown>,
    payloadStatus: row.payload_status ?? "unmarked",
    payloadDiagnostic: row.payload_diagnostic ?? undefined,
    traceId: row.trace_id,
    durationMs: row.duration_ms ?? undefined,
    timeCreated: row.time_created,
  };
}
