import { type Message, Subagent } from "@openomni/protocol";
import { Bus, Session, WorkerRun, type WorkerRunRecord } from "@openomni/session";
import { SubagentSpawnPolicyMiddleware } from "./middleware/subagent-spawn-policy.js";
import { isTerminalStatus } from "./run-lifecycle";

export interface RuntimeWaitConfig {
  readonly sessionId: string;
  readonly runId: string;
  readonly timeoutMs?: number;
}

export interface RuntimeWaitResult {
  readonly status: WorkerRunRecord["status"];
  readonly output?: string;
}

export async function waitForRuntimeRun(config: RuntimeWaitConfig): Promise<RuntimeWaitResult> {
  const policy = await SubagentSpawnPolicyMiddleware.runPreSpawn({
    operation: "wait",
    sessionId: config.sessionId,
    timeoutMs: config.timeoutMs,
  });
  const run = await WorkerRun.get(config.sessionId, config.runId);
  if (!run) {
    throw new Error(`Worker run ${config.runId} not found in session ${config.sessionId}`);
  }

  if (isTerminalStatus(run.status)) {
    return getWaitResult(run);
  }

  return new Promise<RuntimeWaitResult>((resolve, reject) => {
    let settled = false;

    const unsubscribeCompleted = Bus.subscribe(Subagent.Events.WorkerRunCompleted, (data) => {
      if (data.payload.sessionId === config.sessionId && data.payload.runId === config.runId) {
        settle();
      }
    });

    const unsubscribeFailed = Bus.subscribe(Subagent.Events.WorkerRunFailed, (data) => {
      if (data.payload.sessionId === config.sessionId && data.payload.runId === config.runId) {
        settle();
      }
    });

    const timeoutHandle = SubagentSpawnPolicyMiddleware.enforceWaitTimeout(
      policy.waitTimeoutMs,
      () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`wait() timeout exceeded after ${config.timeoutMs}ms`));
        }
      },
    );

    function cleanup() {
      unsubscribeCompleted();
      unsubscribeFailed();
      timeoutHandle?.cancel();
    }

    async function settle() {
      if (settled) return;
      settled = true;
      cleanup();
      const finalRun = await WorkerRun.get(config.sessionId, config.runId);
      if (finalRun) {
        resolve(getWaitResult(finalRun));
      } else {
        reject(new Error(`Worker run ${config.runId} disappeared during wait`));
      }
    }
  });
}

function getWaitResult(run: WorkerRunRecord): RuntimeWaitResult {
  let output: string | undefined;
  if (run.lastMessageId) {
    const parts = Session.getParts(run.lastMessageId);
    output = parts.find((part): part is Message.TextPart => part.type === "text")?.text;
  }

  return { status: run.status, output };
}
