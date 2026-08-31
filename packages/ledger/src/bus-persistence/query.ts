import type { z } from "zod";
import * as ChainQuery from "./chain-query.js";
import * as EventQuery from "./event-query.js";
import * as QueryContracts from "./query-contracts.js";
import * as WorkerRunHistoryQuery from "./worker-run-history-query.js";

export namespace BusQuery {
  /**
   * A persisted bus event record with metadata.
   */
  export const EventRecord = QueryContracts.EventRecord;
  export type EventRecord = z.infer<typeof EventRecord>;

  /**
   * List all error events (operational.error) for a session.
   * @param sessionId - The session ID to query
   * @returns Array of error event records
   */
  export function listErrors(sessionId: string): Promise<EventRecord[]> {
    return EventQuery.listErrors(sessionId);
  }

  /**
   * Get aggregated statistics about events in a session.
   * @param sessionId - The session ID to query
   * @returns Statistics object with counts by category and type
   */
  export function getStats(sessionId: string): Promise<QueryContracts.QueryStats> {
    return queryStats(sessionId);
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
    return WorkerRunHistoryQuery.getWorkerRunHistory(sessionId);
  }

  export const ChainIntegrityResult = QueryContracts.ChainIntegrityResult;
  export type ChainIntegrityResult = z.infer<typeof ChainIntegrityResult>;

  /**
   * Walk the hash chain for a session (or all sessionless events) and
   * re-compute every hash to detect tampering.
   */
  export function verifyChainIntegrity(sessionId?: string): Promise<ChainIntegrityResult> {
    return ChainQuery.verifyChainIntegrity(sessionId);
  }
}

import type { QueryStats } from "./query-contracts.js";
import { getDatabase } from "./database.js";
import type { CategoryCountRow, CountRow, TypeCountRow } from "./query-rows.js";

function queryStats(sessionId: string): Promise<QueryStats> {
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
