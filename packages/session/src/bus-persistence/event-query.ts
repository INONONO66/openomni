import { EventVisibility, type EventRecord, type QueryOptions } from "./query-contracts.js";
import { buildEventFilters, limitClause } from "./event-query-filter.js";
import { getDatabase } from "./query-database.js";
import type { BusEventRow } from "./query-rows.js";

export function listBySession(sessionId: string, options?: QueryOptions): Promise<EventRecord[]> {
  const { where, params } = buildEventFilters("session_id", sessionId, options);
  const rows = getDatabase()
    .query(
      `SELECT * FROM bus_event WHERE ${where} ORDER BY time_created DESC${limitClause(options)}`,
    )
    .all(...params) as BusEventRow[];
  return Promise.resolve(rows.map(toEventRecord));
}

export function listByRun(runId: string, options?: QueryOptions): Promise<EventRecord[]> {
  const { where, params } = buildEventFilters("run_id", runId, options);
  const rows = getDatabase()
    .query(
      `SELECT * FROM bus_event WHERE ${where} ORDER BY time_created DESC${limitClause(options)}`,
    )
    .all(...params) as BusEventRow[];
  return Promise.resolve(rows.map(toEventRecord));
}

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

export function listForLlmReasoning(
  sessionId: string,
  options?: Omit<QueryOptions, "visibility" | "visibilityIn">,
): Promise<EventRecord[]> {
  return listBySession(sessionId, {
    ...options,
    visibilityIn: ["llm_reason", "user_audit"],
  });
}

// merged from event-record-mapper.ts (#453 hygiene: sub-30-LOC single-importer)
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
