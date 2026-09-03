import { getDatabase } from "./database.js";
import type { WorkerRunRow } from "./query-rows.js";

/**
 * Frozen-archive read (#510 D2b): `worker_run_state` gains no new rows —
 * every writer throws the typed `worker_run_frozen` error — so this history
 * query surfaces PRE-FREEZE runs only, read-only over immutable archived
 * rows. New run history is outside this archive query; surfacing
 * that history is #493 projection scope ("#493 owns projections/export/
 * replay").
 */

interface WorkerRunHistory {
  readonly runId: string;
  readonly status: string;
  readonly eventCount: number;
  readonly startTime: number;
  readonly endTime?: number;
}

export function getWorkerRunHistory(sessionId: string): Promise<WorkerRunHistory[]> {
  const rows = getDatabase()
    .query(
      `SELECT wrs.run_id, wrs.status, wrs.time_created, wrs.time_updated,
              COUNT(be.id) AS event_count
       FROM worker_run_state wrs
       LEFT JOIN bus_event be ON be.run_id = wrs.run_id
       WHERE wrs.session_id = ?
       GROUP BY wrs.run_id
       ORDER BY wrs.time_created DESC`,
    )
    .all(sessionId) as WorkerRunRow[];

  return Promise.resolve(
    rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      eventCount: row.event_count,
      startTime: row.time_created,
      endTime: row.time_updated,
    })),
  );
}
