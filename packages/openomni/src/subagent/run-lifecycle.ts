import { Subagent } from "@openomni/protocol";
import { Session, WorkerRun } from "@openomni/session";
import {
  abort as abortSession,
  get as getAbortEntry,
  remove as removeAbortController,
} from "./abort-registry";
import { publishEvent } from "./shared";

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
    timers.soft = setTimeout(() => {
      publishEvent(Subagent.Events.WorkerRunFailed, {
        sessionId,
        runId,
        error: "soft timeout exceeded",
      });
    }, softTimeoutMs);
  }

  if (hardTimeoutMs !== undefined) {
    timers.hard = setTimeout(async () => {
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
