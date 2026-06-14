import { PolicyDecision, Subagent } from "@openomni/protocol";
import { WorkerRun } from "@openomni/session";
import { get as getAbortEntry } from "./abort-registry";
import { SubagentSpawnPolicyMiddleware } from "./middleware/subagent-spawn-policy.js";
import { isTerminalStatus, raceAbortCompletion } from "./run-lifecycle";
import { publishEvent } from "./shared";

export interface RuntimeCancelConfig {
  readonly sessionId: string;
  readonly runId?: string;
  readonly hardTimeoutMs?: number;
}

export async function cancelRuntimeRun(config: RuntimeCancelConfig): Promise<void> {
  const policy = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
    operation: "cancel",
    sessionId: config.sessionId,
    hardTimeoutMs: config.hardTimeoutMs,
  });
  if (PolicyDecision.isBlocking(policy.verdict)) return;
  const session = policy.session;
  if (!session) return;

  const hardTimeoutMs = policy.cancelHardTimeoutMs;

  if (config.runId) {
    await cancelSpecificRun(config.sessionId, config.runId, hardTimeoutMs);
    return;
  }

  await cancelActiveRun(config.sessionId, hardTimeoutMs);
}

async function cancelSpecificRun(
  sessionId: string,
  runId: string,
  hardTimeoutMs: number,
): Promise<void> {
  const entry = getAbortEntry(sessionId, runId);
  const hasInFlightOp = !!entry;

  if (hasInFlightOp) {
    entry.controller.abort();
    await raceAbortCompletion(sessionId, runId, hardTimeoutMs);
  } else {
    const run = await WorkerRun.get(sessionId, runId);
    if (run && !isTerminalStatus(run.status)) {
      await WorkerRun.updateStatus(sessionId, runId, "cancelled", {
        endedAt: Date.now(),
      });
    }
  }

  publishEvent(Subagent.Events.WorkerSessionCancelled, { sessionId, runId });
}

async function cancelActiveRun(sessionId: string, hardTimeoutMs: number): Promise<void> {
  const runs = await WorkerRun.listBySession(sessionId);
  const activeRun = runs.find((run) => run.status === "running" || run.status === "starting");
  const abortEntry = activeRun ? getAbortEntry(sessionId, activeRun.runId) : undefined;

  if (abortEntry) {
    abortEntry.controller.abort();
  }

  if (activeRun) {
    if (abortEntry) {
      await raceAbortCompletion(sessionId, activeRun.runId, hardTimeoutMs);
    } else {
      await WorkerRun.updateStatus(sessionId, activeRun.runId, "cancelled", {
        endedAt: Date.now(),
      });
    }
  }

  publishEvent(Subagent.Events.WorkerSessionCancelled, {
    sessionId,
    runId: activeRun?.runId,
  });
}
