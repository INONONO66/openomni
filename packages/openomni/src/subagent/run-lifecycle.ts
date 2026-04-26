import type { ChatAgent } from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import { Log, Session, WorkerRun } from "@openomni/session";
import {
  abort as abortSession,
  get as getAbortEntry,
  remove as removeAbortController,
} from "./abort-registry";
import { addAssistantResultParts } from "./message-builder";
import { createAssistantMessage, publishEvent, type RuntimeModel } from "./shared";

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
    await WorkerRun.updateStatus(sessionId, runId, "failed", { endedAt: Date.now() });
    publishEvent(Subagent.Events.WorkerRunFailed, {
      sessionId,
      runId,
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
  Log.debug("run.abort.settled", { sessionId, runId, outcome: winner });

  if (winner === "timeout") {
    removeAbortController(sessionId, runId);
    const run = await WorkerRun.get(sessionId, runId);
    if (run && !isTerminalStatus(run.status)) {
      await WorkerRun.updateStatus(sessionId, runId, "interrupted", { endedAt: Date.now() });
    }
    publishEvent(Subagent.Events.WorkerRunFailed, {
      sessionId,
      runId,
      error: "cancel timeout exceeded",
    });
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
    Log.debug("run.timeout.setup.soft", { sessionId, runId, softTimeoutMs });
    timers.soft = setTimeout(() => {
      Log.debug("run.timeout.soft-fired", { sessionId, runId });
      publishEvent(Subagent.Events.WorkerRunFailed, {
        sessionId,
        runId,
        error: "soft timeout exceeded",
      });
    }, softTimeoutMs);
  }

  if (hardTimeoutMs !== undefined) {
    Log.debug("run.timeout.setup.hard", { sessionId, runId, hardTimeoutMs });
    timers.hard = setTimeout(async () => {
      Log.debug("run.timeout.hard-fired", { sessionId, runId });
      try {
        await WorkerRun.updateStatus(sessionId, runId, "interrupted", { endedAt: Date.now() });
      } catch {
        return;
      }
      publishEvent(Subagent.Events.WorkerRunFailed, {
        sessionId,
        runId,
        error: "hard timeout exceeded",
      });
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
    publishEvent(Subagent.Events.WorkerRunCompleted, { sessionId, runId, status: "succeeded" });
    return { sessionId, runId, output: result.text, finishReason: result.finishReason };
  } catch (error) {
    if (await shouldSkipFailureUpdate(sessionId, runId)) throw error;
    await WorkerRun.updateStatus(sessionId, runId, "failed", { endedAt: Date.now() });
    publishEvent(Subagent.Events.WorkerRunFailed, {
      sessionId,
      runId,
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
