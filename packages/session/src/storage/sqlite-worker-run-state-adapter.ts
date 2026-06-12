import type { Database } from "bun:sqlite";
import type { WorkerRunStateStore } from "../worker-run/state-store";

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

    updateStatus: (
      sessionId: string,
      runId: string,
      status: WorkerRunStateStore.Status,
      extra?: WorkerRunStateStore.StatusExtra,
    ): boolean => {
      const result = db
        .query(
          `UPDATE worker_run_state
           SET status = ?,
               error = COALESCE(?, error),
               resume_count = CASE
                 WHEN status = 'waiting_input' AND ? = 'running' THEN resume_count + 1
                 ELSE resume_count
               END,
               time_updated = MAX(?, time_updated + 1)
           WHERE session_id = ? AND run_id = ?`,
        )
        .run(status, extra?.error ?? null, status, Date.now(), sessionId, runId);
      return result.changes > 0;
    },

    updateStatusIfCurrent: (
      sessionId: string,
      runId: string,
      expected: WorkerRunStateStore.StatusPrecondition,
      status: WorkerRunStateStore.Status,
      extra?: WorkerRunStateStore.StatusExtra,
    ): boolean => {
      const result = db
        .query(
          `UPDATE worker_run_state
           SET status = ?,
               error = COALESCE(?, error),
               resume_count = CASE
                 WHEN status = 'waiting_input' AND ? = 'running' THEN resume_count + 1
                 ELSE resume_count
               END,
               time_updated = MAX(?, time_updated + 1)
           WHERE session_id = ?
             AND run_id = ?
             AND status = ?
             AND time_updated = ?`,
        )
        .run(
          status,
          extra?.error ?? null,
          status,
          Date.now(),
          sessionId,
          runId,
          expected.status,
          expected.timeUpdated,
        );
      return result.changes > 0;
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
