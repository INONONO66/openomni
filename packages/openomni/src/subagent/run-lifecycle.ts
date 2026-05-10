import type { ChatAgent } from "@openomni/agent";
import { Operational } from "@openomni/protocol";
import { Bus, Session, WorkerRun } from "@openomni/session";
import {
  abort as abortSession,
  get as getAbortEntry,
  remove as removeAbortController,
} from "./abort-registry";
import { addAssistantResultParts } from "./message-builder";
import { createAssistantMessage, type RuntimeModel } from "./shared";

export function buildAbortSignal(controller: AbortController, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any(
    [controller.signal, signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
}

export async function shouldSkipFailureUpdate(sessionId: string, runId: string): Promise<boolean> {
  const run = await WorkerRun.get(sessionId, runId);
  if (run?.status === "cancelled" || run?.status === "interrupted") return true;
  // Cancel in progress: controller aborted but entry kept for completion tracking
  const entry = getAbortEntry(sessionId, runId);
  return !!entry && entry.controller.signal.aborted;
}

export function isTerminalStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export function resolveMetaStatus(runStatus: string | undefined): string {
  switch (runStatus) {
    case "succeeded":
      return "idle";
    case "failed":
    case "cancelled":
    case "interrupted":
      return runStatus;
    default:
      return "idle";
  }
}

export async function finalizeRun(sessionId: string, runId: string): Promise<void> {
  const run = await WorkerRun.get(sessionId, runId);
  if (run && !isTerminalStatus(run.status) && !(await shouldSkipFailureUpdate(sessionId, runId))) {
    await WorkerRun.updateStatus(sessionId, runId, "failed", {
      endedAt: Date.now(),
      error: "non-terminal status at finally cleanup",
    });
  }

  const finalRun = await WorkerRun.get(sessionId, runId);
  const meta = Session.getWorkerMeta(sessionId);
  if (meta && typeof meta === "object") {
    Session.updateWorkerMeta(sessionId, {
      ...meta,
      status: resolveMetaStatus(finalRun?.status),
    });
  }
}

export async function waitForAbortEntryRemoval(sessionId: string, runId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (getAbortEntry(sessionId, runId) === undefined) return;
    await Promise.resolve();
  }
  while (getAbortEntry(sessionId, runId) !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function raceAbortCompletion(
  sessionId: string,
  runId: string,
  hardTimeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortWait = waitForAbortEntryRemoval(sessionId, runId).then(() => "settled" as const);
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), hardTimeoutMs);
  });

  const winner = await Promise.race([abortWait, timeout]);
  Bus.publish(Operational.Debug, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "subagent.lifecycle",
    msg: "run.abort.settled",
    context: { sessionId, runId, outcome: winner },
  });

  if (winner === "timeout") {
    removeAbortController(sessionId, runId);
    const run = await WorkerRun.get(sessionId, runId);
    if (run && !isTerminalStatus(run.status)) {
      await WorkerRun.updateStatus(sessionId, runId, "interrupted", {
        endedAt: Date.now(),
        error: "cancel timeout exceeded",
      });
    }
  } else {
    clearTimeout(timeoutId);
    const run = await WorkerRun.get(sessionId, runId);
    if (run && !isTerminalStatus(run.status)) {
      await WorkerRun.updateStatus(sessionId, runId, "cancelled", { endedAt: Date.now() });
    }
  }
}

export type TimeoutTimers = {
  soft?: ReturnType<typeof setTimeout>;
  hard?: ReturnType<typeof setTimeout>;
};

export function setupRunTimeouts(
  sessionId: string,
  runId: string,
  softTimeoutMs?: number,
  hardTimeoutMs?: number,
): TimeoutTimers {
  const timers: TimeoutTimers = {};

  if (softTimeoutMs !== undefined) {
    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "subagent.lifecycle",
      msg: "run.timeout.setup.soft",
      context: { sessionId, runId, softTimeoutMs },
    });
    timers.soft = setTimeout(() => {
      Bus.publish(Operational.Debug, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "subagent.lifecycle",
        msg: "run.timeout.soft-fired",
        context: { sessionId, runId },
      });
    }, softTimeoutMs);
  }

  if (hardTimeoutMs !== undefined) {
    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "subagent.lifecycle",
      msg: "run.timeout.setup.hard",
      context: { sessionId, runId, hardTimeoutMs },
    });
    timers.hard = setTimeout(async () => {
      Bus.publish(Operational.Debug, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "subagent.lifecycle",
        msg: "run.timeout.hard-fired",
        context: { sessionId, runId },
      });
      try {
        await WorkerRun.updateStatus(sessionId, runId, "interrupted", {
          endedAt: Date.now(),
          error: "hard timeout exceeded",
        });
      } catch {
        return;
      }
      abortSession(sessionId, runId);
    }, hardTimeoutMs);
  }

  return timers;
}

export function clearRunTimeouts(timers: TimeoutTimers): void {
  if (timers.soft) clearTimeout(timers.soft);
  if (timers.hard) clearTimeout(timers.hard);
}

type AgentRunResult = Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>;

export async function executeRun(
  sessionId: string,
  runId: string,
  model: RuntimeModel,
  timers: TimeoutTimers | undefined,
  runFn: () => Promise<AgentRunResult>,
): Promise<{
  sessionId: string;
  runId: string;
  output: string;
  finishReason: AgentRunResult["finishReason"];
}> {
  try {
    const result = await runFn();
    const assistantMessage = createAssistantMessage(sessionId, model);
    Session.addMessage(sessionId, assistantMessage);
    addAssistantResultParts(sessionId, assistantMessage.id, result);
    await WorkerRun.updateStatus(sessionId, runId, "succeeded", {
      endedAt: Date.now(),
      lastMessageId: assistantMessage.id,
    });
    return { sessionId, runId, output: result.text, finishReason: result.finishReason };
  } catch (error) {
    if (await shouldSkipFailureUpdate(sessionId, runId)) throw error;
    await WorkerRun.updateStatus(sessionId, runId, "failed", {
      endedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (timers) clearRunTimeouts(timers);
    try {
      await finalizeRun(sessionId, runId);
    } catch {
      // cleanup must not mask the original error
    }
    removeAbortController(sessionId, runId);
  }
}
