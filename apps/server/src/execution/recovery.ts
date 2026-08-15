import { WorkItemAttemptRun } from "@openomni/session";

export type RecoveryResult = {
  recovered: number;
  sessions: string[];
};

/**
 * #510 D2b — boot recovery over WorkItem attempt facts: every active
 * in-process run (attempt allocated, not finished) died with the previous
 * process, so its terminal truth is an `interrupted` attempt fact. Scoped to
 * `internal_chat_agent` executors — connector-endpoint / external attempts
 * survive a kernel restart and complete through `worker.complete`. Frozen
 * legacy worker_run_state rows need no sweep: their upcast read already
 * folds non-terminal statuses to `interrupted`.
 */
export async function recoverInterruptedRuns(traceId: string): Promise<RecoveryResult> {
  const recovered: string[] = [];

  for (const run of WorkItemAttemptRun.listActive()) {
    if (run.executorKind !== "internal_chat_agent") continue;
    const interrupted = await WorkItemAttemptRun.finish(
      run.sessionId,
      run.runId,
      "interrupted",
      traceId,
      {
        endedAt: Date.now(),
        error: "coordinator restarted: run interrupted",
      },
    );
    if (interrupted) recovered.push(run.sessionId);
  }

  return { recovered: recovered.length, sessions: [...new Set(recovered)] };
}
