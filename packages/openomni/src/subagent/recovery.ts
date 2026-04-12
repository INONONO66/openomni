import type { PlanStep } from "@openomni/protocol";
import { Session, WorkerRun } from "@openomni/session";
import { SubagentRuntime } from "./runtime";
import { RunLedger, type RunLedgerInstance } from "../team/run-ledger";

function getWorkerStatus(meta: Record<string, unknown> | undefined): string | undefined {
  const status = meta?.status;
  return typeof status === "string" ? status : undefined;
}

async function interruptIncompleteRuns(sessionId: string): Promise<void> {
  const runs = await WorkerRun.listBySession(sessionId);

  for (const run of runs) {
    if (run.status === "running") {
      await WorkerRun.updateStatus(sessionId, run.runId, "interrupted", {
        endedAt: Date.now(),
      });
      continue;
    }

    if (run.status === "starting") {
      await WorkerRun.updateStatus(sessionId, run.runId, "running");
      await WorkerRun.updateStatus(sessionId, run.runId, "interrupted", {
        endedAt: Date.now(),
      });
    }
  }
}

export async function recoverSubagentSessions(
  orchestrationSessionId: string,
  steps: PlanStep[],
): Promise<RunLedgerInstance> {
  const ledger = RunLedger.recover(orchestrationSessionId, steps);
  const childSessions = Session.listChildren(orchestrationSessionId);

  for (const childSession of childSessions) {
    await interruptIncompleteRuns(childSession.id);

    if (getWorkerStatus(childSession.workerMeta) === "running") {
      await SubagentRuntime.cancel({ sessionId: childSession.id });
    }
  }

  return ledger;
}
