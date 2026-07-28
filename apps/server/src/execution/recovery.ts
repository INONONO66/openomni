import { Session, WorkerRun } from "@openomni/session";

export type RecoveryResult = {
  recovered: number;
  sessions: string[];
};

export async function recoverInterruptedRuns(): Promise<RecoveryResult> {
  const recovered: string[] = [];

  for (const session of Session.list()) {
    const runs = await WorkerRun.listBySession(session.id);
    const incompleteRuns = runs.filter(
      (r) => r.status === "running" || r.status === "starting" || r.status === "waiting_input",
    );

    for (const run of incompleteRuns) {
      const interrupted = await WorkerRun.updateStatusIfCurrent(
        session.id,
        run.runId,
        { status: run.status, timeUpdated: run.timeUpdated },
        "interrupted",
        {
          endedAt: Date.now(),
          error: "coordinator restarted: run interrupted",
        },
      );

      if (interrupted) recovered.push(session.id);
    }
  }

  return { recovered: recovered.length, sessions: [...new Set(recovered)] };
}
