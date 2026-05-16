import { Subagent } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { WorkerRunStateStore } from "./state-store.js";

// Subagent execution lifecycle per session, kept separate from user-facing work items.

export type WorkerRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WorkerRunRecord {
  runId: string;
  sessionId: string;
  parentSessionId?: string;
  title: string;
  prompt: string;
  assignedStepId?: string;
  status: WorkerRunStatus;
  startedAt: number;
  endedAt?: number;
  lastMessageId?: string;
  error?: string;
  resumeCount: number;
}

type WorkerRunStatusExtra = {
  endedAt?: number;
  lastMessageId?: string;
  error?: string;
};

const terminalStatuses: ReadonlySet<WorkerRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const runExtras = new Map<string, Pick<WorkerRunRecord, "endedAt" | "lastMessageId">>();

function extraKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

function publishLifecycleEvent(
  sessionId: string,
  run: WorkerRunRecord,
  status: WorkerRunStatus,
  error?: string,
): void {
  if (status === "starting") {
    Bus.publish(Subagent.Events.WorkerRunStarted, {
      traceId: crypto.randomUUID(),
      sessionId,
      runId: run.runId,
      time: Date.now(),
      payload: { sessionId, runId: run.runId, title: run.title },
    });
    return;
  }

  if (status === "succeeded") {
    Bus.publish(Subagent.Events.WorkerRunCompleted, {
      traceId: crypto.randomUUID(),
      sessionId,
      runId: run.runId,
      time: Date.now(),
      payload: { sessionId, runId: run.runId, status },
    });
    return;
  }

  if (status === "failed" || status === "interrupted") {
    Bus.publish(Subagent.Events.WorkerRunFailed, {
      traceId: crypto.randomUUID(),
      sessionId,
      runId: run.runId,
      time: Date.now(),
      payload: { sessionId, runId: run.runId, error },
    });
  }
}

function toWorkerRunRecord(record: WorkerRunStateStore.Record): WorkerRunRecord {
  const extras = runExtras.get(extraKey(record.sessionId, record.runId));
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    parentSessionId: record.parentSessionId,
    title: record.title,
    prompt: record.prompt,
    assignedStepId: record.assignedStepId,
    status: record.status,
    startedAt: record.timeCreated,
    endedAt:
      extras?.endedAt ?? (terminalStatuses.has(record.status) ? record.timeUpdated : undefined),
    lastMessageId: extras?.lastMessageId,
    error: record.error,
    resumeCount: record.resumeCount,
  };
}

export namespace WorkerRun {
  export async function create(
    sessionId: string,
    run: {
      runId: string;
      title: string;
      prompt: string;
      assignedStepId?: string;
      agentName?: string;
      parentSessionId?: string;
    },
  ): Promise<void> {
    runExtras.delete(extraKey(sessionId, run.runId));
    WorkerRunStateStore.create(sessionId, {
      runId: run.runId,
      parentSessionId: run.parentSessionId,
      agentName: run.agentName ?? "worker",
      status: "queued",
      title: run.title,
      prompt: run.prompt,
      assignedStepId: run.assignedStepId,
    });
  }

  export async function get(
    sessionId: string,
    runId: string,
  ): Promise<WorkerRunRecord | undefined> {
    const run = WorkerRunStateStore.get(sessionId, runId);
    return run ? toWorkerRunRecord(run) : undefined;
  }

  export async function listBySession(sessionId: string): Promise<WorkerRunRecord[]> {
    return WorkerRunStateStore.listBySession(sessionId).map(toWorkerRunRecord);
  }

  export async function listByStatus(status: WorkerRunStatus): Promise<WorkerRunRecord[]> {
    return WorkerRunStateStore.listByStatus(status).map(toWorkerRunRecord);
  }

  export async function updateStatus(
    sessionId: string,
    runId: string,
    status: WorkerRunStatus,
    extra?: WorkerRunStatusExtra,
  ): Promise<void> {
    const current = await get(sessionId, runId);
    if (!current) {
      throw new Error(`Worker run ${runId} not found in session ${sessionId}`);
    }

    WorkerRunStateStore.updateStatus(sessionId, runId, status, { error: extra?.error });

    if (extra?.endedAt !== undefined || extra?.lastMessageId !== undefined) {
      const key = extraKey(sessionId, runId);
      const previous = runExtras.get(key);
      runExtras.set(key, {
        endedAt: extra.endedAt ?? previous?.endedAt,
        lastMessageId: extra.lastMessageId ?? previous?.lastMessageId,
      });
    }

    if (current.status !== status) {
      publishLifecycleEvent(sessionId, current, status, extra?.error);
    }
  }
}
