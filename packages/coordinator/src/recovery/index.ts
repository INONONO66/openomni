import { Bus, Session, WorkerRun } from "@openomni/session";
import { Subagent } from "@openomni/protocol";

export type RecoveryResult = {
  recovered: number;
  sessions: string[];
};

export async function recoverInterruptedRuns(): Promise<RecoveryResult> {
  const recovered: string[] = [];

  for (const session of Session.list()) {
    const runs = await WorkerRun.listBySession(session.id);
    const incompleteRuns = runs.filter((r) => r.status === "running" || r.status === "starting");

    for (const run of incompleteRuns) {
      // starting → running is the only valid transition before → interrupted
      if (run.status === "starting") {
        await WorkerRun.updateStatus(session.id, run.runId, "running");
      }

      await WorkerRun.updateStatus(session.id, run.runId, "interrupted", {
        endedAt: Date.now(),
      });

      Bus.publish(Subagent.Events.WorkerRunFailed, {
        traceId: crypto.randomUUID(),
        sessionId: session.id,
        runId: run.runId,
        time: Date.now(),
        payload: {
          sessionId: session.id,
          runId: run.runId,
          error: "coordinator restarted: run interrupted",
        },
      });

      recovered.push(session.id);
    }
  }

  return { recovered: recovered.length, sessions: [...new Set(recovered)] };
}
