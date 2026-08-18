import type { Database } from "bun:sqlite";
import type { WorkerRunStateStore } from "../worker-run/state-store";

/**
 * @internal The remaining write surface (`create`) is TEST-ONLY seeding of
 * historical rows: the store is frozen (#510 D2b — its writers throw
 * `worker_run_frozen`) and no production path reaches this. Tests across
 * session/openomni/server seed pre-freeze archive rows here, exactly as such
 * rows persist on disk. The adapter-level update branches were deleted with
 * #498 K1 — nothing (tests or scripts included) reached them; the store's
 * throwing updateStatus/updateStatusIfCurrent never touch the adapter. Do
 * not wire new production callers.
 */
export function createSqliteWorkerRunStateAdapter(db: Database): WorkerRunStateStore.Adapter {
  return {
    create: (sessionId: string, record: WorkerRunStateStore.CreateRecord): void => {
      const now = Date.now();
      const timeCreated = record.timeCreated ?? now;
      const timeUpdated = record.timeUpdated ?? timeCreated;
      db.query(
        `INSERT INTO worker_run_state (
           run_id,
           session_id,
           parent_session_id,
           agent_name,
           status,
           executor_kind,
           title,
           prompt,
           resume_count,
           assigned_step_id,
           error,
           time_created,
           time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.runId,
        sessionId,
        record.parentSessionId ?? null,
        record.agentName,
        record.status,
        record.executorKind ?? null,
        record.title,
        record.prompt,
        record.resumeCount ?? 0,
        record.assignedStepId ?? null,
        record.error ?? null,
        timeCreated,
        timeUpdated,
      );
    },

    get: (sessionId: string, runId: string): WorkerRunStateStore.Record | undefined => {
      const row = db
        .query(
          `SELECT run_id, session_id, parent_session_id, agent_name, status, executor_kind, title, prompt,
                  resume_count, assigned_step_id, error, time_created, time_updated
           FROM worker_run_state
           WHERE session_id = ? AND run_id = ?`,
        )
        .get(sessionId, runId) as WorkerRunStateRow | null;
      return row ? toWorkerRunStateRecord(row) : undefined;
    },

    listBySession: (sessionId: string): WorkerRunStateStore.Record[] => {
      const rows = db
        .query(
          `SELECT run_id, session_id, parent_session_id, agent_name, status, executor_kind, title, prompt,
                  resume_count, assigned_step_id, error, time_created, time_updated
           FROM worker_run_state
           WHERE session_id = ?
           ORDER BY time_created ASC, rowid ASC`,
        )
        .all(sessionId) as WorkerRunStateRow[];
      return rows.map(toWorkerRunStateRecord);
    },

    listByStatus: (status: WorkerRunStateStore.Status): WorkerRunStateStore.Record[] => {
      const rows = db
        .query(
          `SELECT run_id, session_id, parent_session_id, agent_name, status, executor_kind, title, prompt,
                  resume_count, assigned_step_id, error, time_created, time_updated
           FROM worker_run_state
           WHERE status = ?
           ORDER BY time_created ASC, rowid ASC`,
        )
        .all(status) as WorkerRunStateRow[];
      return rows.map(toWorkerRunStateRecord);
    },
  };
}

type WorkerRunStateRow = {
  run_id: string;
  session_id: string;
  parent_session_id: string | null;
  agent_name: string;
  status: WorkerRunStateStore.Status;
  executor_kind: WorkerRunStateStore.Record["executorKind"] | null;
  title: string;
  prompt: string;
  resume_count: number;
  assigned_step_id: string | null;
  error: string | null;
  time_created: number;
  time_updated: number;
};

function toWorkerRunStateRecord(row: WorkerRunStateRow): WorkerRunStateStore.Record {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id ?? undefined,
    agentName: row.agent_name,
    status: row.status,
    executorKind: row.executor_kind ?? undefined,
    title: row.title,
    prompt: row.prompt,
    resumeCount: row.resume_count,
    assignedStepId: row.assigned_step_id ?? undefined,
    error: row.error ?? undefined,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}
