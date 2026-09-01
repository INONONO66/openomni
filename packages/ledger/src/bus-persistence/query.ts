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
