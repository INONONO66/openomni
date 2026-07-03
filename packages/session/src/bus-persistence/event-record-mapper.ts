import { EventVisibility, type EventRecord } from "./query-contracts.js";
import type { BusEventRow } from "./query-rows.js";

export function toEventRecord(row: BusEventRow): EventRecord {
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
