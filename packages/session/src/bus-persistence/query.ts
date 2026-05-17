import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Storage } from "../storage/storage.js";

type SqlValue = string | number;

interface PersistableAdapter {
  readonly db?: Database;
}

interface BusEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly category: string;
  readonly data: string;
  readonly trace_id: string;
  readonly duration_ms: number | null;
  readonly time_created: number;
}

interface CountRow {
  readonly count: number;
}

interface CategoryCountRow extends CountRow {
  readonly category: string;
}

interface TypeCountRow extends CountRow {
  readonly event_type: string;
}

interface WorkerRunRow {
  readonly run_id: string;
  readonly status: string;
  readonly time_created: number;
  readonly time_updated: number;
}

export namespace BusQuery {
  /**
   * A persisted bus event record with metadata.
   */
  export const EventRecord = z.object({
    id: z.string().describe("Unique event record ID"),
    sessionId: z.string().describe("Session ID this event belongs to"),
    runId: z.string().optional().describe("Worker run ID if applicable"),
    eventType: z.string().describe("Event type name (e.g., 'agent.execution.started')"),
    category: z.string().describe("Event category"),
    data: z.record(z.string(), z.unknown()).describe("Event payload data"),
    traceId: z.string().describe("Trace ID for correlation"),
    durationMs: z.number().optional().describe("Duration in milliseconds if applicable"),
    timeCreated: z.number().describe("Timestamp when event was created (ms since epoch)"),
  });
  export type EventRecord = z.infer<typeof EventRecord>;

  /**
   * Query options for filtering bus events.
   */
  export const QueryOptions = z.object({
    type: z.string().optional().describe("Filter by event type"),
    category: z.string().optional().describe("Filter by category"),
    after: z.number().optional().describe("Only events after this timestamp (ms)"),
    before: z.number().optional().describe("Only events before this timestamp (ms)"),
    limit: z.number().int().positive().optional().describe("Maximum number of results"),
  });
  export type QueryOptions = z.infer<typeof QueryOptions>;

  /**
   * Statistics about bus events in a session.
   */
  export const QueryStats = z.object({
    totalEvents: z.number().describe("Total number of events"),
    byCategory: z.record(z.number()).describe("Event count by category"),
    byType: z.record(z.number()).describe("Event count by type"),
  });
  export type QueryStats = z.infer<typeof QueryStats>;

  /**
   * List all bus events for a session with optional filtering.
   * @param sessionId - The session ID to query
   * @param options - Optional query filters
   * @returns Array of event records
   */
  export function listBySession(sessionId: string, options?: QueryOptions): Promise<EventRecord[]> {
    const { where, params } = buildEventFilters("session_id", sessionId, options);
    const rows = getDatabase()
      .query(
        `SELECT * FROM bus_event WHERE ${where} ORDER BY time_created DESC${limitClause(options)}`,
      )
      .all(...params) as BusEventRow[];
    return Promise.resolve(rows.map(toEventRecord));
  }

  /**
   * List all bus events for a specific worker run.
   * @param runId - The worker run ID to query
   * @param options - Optional query filters
   * @returns Array of event records
   */
  export function listByRun(runId: string, options?: QueryOptions): Promise<EventRecord[]> {
    const { where, params } = buildEventFilters("run_id", runId, options);
    const rows = getDatabase()
      .query(
        `SELECT * FROM bus_event WHERE ${where} ORDER BY time_created DESC${limitClause(options)}`,
      )
      .all(...params) as BusEventRow[];
    return Promise.resolve(rows.map(toEventRecord));
  }

  /**
   * List all error events (operational.error) for a session.
   * @param sessionId - The session ID to query
   * @returns Array of error event records
   */
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

  /**
   * Get aggregated statistics about events in a session.
   * @param sessionId - The session ID to query
   * @returns Statistics object with counts by category and type
   */
  export function getStats(sessionId: string): Promise<QueryStats> {
    const db = getDatabase();
    const total = db
      .query("SELECT COUNT(*) as count FROM bus_event WHERE session_id = ?")
      .get(sessionId) as CountRow;
    const categoryRows = db
      .query(
        "SELECT category, COUNT(*) as count FROM bus_event WHERE session_id = ? GROUP BY category",
      )
      .all(sessionId) as CategoryCountRow[];
    const typeRows = db
      .query(
        "SELECT event_type, COUNT(*) as count FROM bus_event WHERE session_id = ? GROUP BY event_type",
      )
      .all(sessionId) as TypeCountRow[];

    return Promise.resolve({
      totalEvents: total.count,
      byCategory: Object.fromEntries(categoryRows.map((row) => [row.category, row.count])),
      byType: Object.fromEntries(typeRows.map((row) => [row.event_type, row.count])),
    });
  }

  /**
   * Get the history of worker runs for a session with their associated events.
   * @param sessionId - The session ID to query
   * @returns Array of worker run records with event summaries
   */
  export function getWorkerRunHistory(sessionId: string): Promise<
    Array<{
      runId: string;
      status: string;
      eventCount: number;
      startTime: number;
      endTime?: number;
    }>
  > {
    const rows = getDatabase()
      .query(
        `SELECT run_id, status, time_created, time_updated
         FROM worker_run_state
         WHERE session_id = ?
         ORDER BY time_created DESC`,
      )
      .all(sessionId) as WorkerRunRow[];

    return Promise.resolve(
      rows.map((row) => ({
        runId: row.run_id,
        status: row.status,
        eventCount: 0,
        startTime: row.time_created,
        endTime: row.time_updated,
      })),
    );
  }
}

function getDatabase(): Database {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  if (!adapter.db) throw new Error("BusQuery requires SQLite-backed storage");
  return adapter.db;
}

function buildEventFilters(
  scopedColumn: "session_id" | "run_id",
  scopedValue: string,
  options: BusQuery.QueryOptions | undefined,
): { where: string; params: SqlValue[] } {
  const clauses = [`${scopedColumn} = ?`];
  const params: SqlValue[] = [scopedValue];

  if (options?.type !== undefined) {
    clauses.push("event_type = ?");
    params.push(options.type);
  }
  if (options?.category !== undefined) {
    clauses.push("category = ?");
    params.push(options.category);
  }
  if (options?.after !== undefined) {
    clauses.push("time_created > ?");
    params.push(options.after);
  }
  if (options?.before !== undefined) {
    clauses.push("time_created < ?");
    params.push(options.before);
  }
  if (options?.limit !== undefined) {
    params.push(options.limit);
  }

  return { where: clauses.join(" AND "), params };
}

function limitClause(options: BusQuery.QueryOptions | undefined): string {
  return options?.limit === undefined ? "" : " LIMIT ?";
}

function toEventRecord(row: BusEventRow): BusQuery.EventRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    eventType: row.event_type,
    category: row.category,
    data: JSON.parse(row.data) as Record<string, unknown>,
    traceId: row.trace_id,
    durationMs: row.duration_ms ?? undefined,
    timeCreated: row.time_created,
  };
}
