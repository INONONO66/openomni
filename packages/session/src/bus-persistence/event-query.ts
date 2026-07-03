import type { EventRecord, QueryOptions } from "./query-contracts.js";
import { buildEventFilters, limitClause } from "./event-query-filter.js";
import { toEventRecord } from "./event-record-mapper.js";
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
