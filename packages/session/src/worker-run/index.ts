import { ExecutionEvent, Subagent } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage";

// Subagent execution lifecycle per session. Separate from Task.Run in @openomni/openomni,
// which handles scheduled-task runs (triggers, idempotency, checkpoints).

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
  title: string;
  prompt: string;
  assignedStepId?: string;
  status: WorkerRunStatus;
  startedAt: number;
  endedAt?: number;
  lastMessageId?: string;
  resumeCount: number;
}

type WorkerRunCreatedEvent = {
  runId: string;
  title: string;
  prompt: string;
  assignedStepId?: string;
  startedAt: number;
};

type WorkerRunStatusUpdatedEvent = {
  runId: string;
  status: WorkerRunStatus;
  endedAt?: number;
  lastMessageId?: string;
};

type WorkerRunStatusExtra = {
  endedAt?: number;
  lastMessageId?: string;
  error?: string;
};

const TRANSITIONS: Record<WorkerRunStatus, readonly WorkerRunStatus[]> = {
  queued: ["starting"],
  starting: ["running"],
  running: ["waiting_input", "succeeded", "failed", "cancelled", "interrupted"],
  waiting_input: ["running"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

function getAdapter(): Storage.Adapter["eventLog"] | undefined {
  return Storage.get().eventLog;
}

function appendExecutionEvent(sessionId: string, event: ExecutionEvent): void {
  const adapter = getAdapter();
  if (adapter) {
    adapter.append(sessionId, event.type, JSON.stringify(event));
  }
}

function parseExecutionEvent(data: string): ExecutionEvent | null {
  try {
    const parsed = ExecutionEvent.Schema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseCreatedEvent(data: string): WorkerRunCreatedEvent | null {
  try {
    const parsed = JSON.parse(data) as Partial<WorkerRunCreatedEvent>;
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.prompt !== "string" ||
      typeof parsed.startedAt !== "number"
    ) {
      return null;
    }
    return parsed as WorkerRunCreatedEvent;
  } catch {
    return null;
  }
}

function parseStatusUpdatedEvent(data: string): WorkerRunStatusUpdatedEvent | null {
  try {
    const parsed = JSON.parse(data) as Partial<WorkerRunStatusUpdatedEvent>;
    if (typeof parsed.runId !== "string" || typeof parsed.status !== "string") {
      return null;
    }
    if (!(parsed.status in TRANSITIONS)) {
      return null;
    }
    return parsed as WorkerRunStatusUpdatedEvent;
  } catch {
    return null;
  }
}

function isValidTransition(current: WorkerRunStatus, next: WorkerRunStatus): boolean {
  return current === next || TRANSITIONS[current].includes(next);
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

function replayRuns(sessionId: string): Map<string, WorkerRunRecord> {
  const adapter = getAdapter();
  const runs = new Map<string, WorkerRunRecord>();

  if (!adapter) {
    return runs;
  }

  for (const row of adapter.replay(sessionId)) {
    if (row.type === "worker_run_created") {
      const event = parseExecutionEvent(row.data);
      if (!event || event.type !== "worker_run_created") continue;

      runs.set(event.runId, {
        runId: event.runId,
        sessionId,
        title: event.title,
        prompt: event.prompt,
        assignedStepId: event.assignedStepId,
        status: "queued",
        startedAt: event.startedAt,
        resumeCount: 0,
      });
      continue;
    }

    if (row.type === "worker_run_status_changed") {
      const event = parseExecutionEvent(row.data);
      if (!event || event.type !== "worker_run_status_changed") continue;

      const current = runs.get(event.runId);
      if (!current || !isValidTransition(current.status, event.status)) {
        continue;
      }

      const next: WorkerRunRecord = {
        ...current,
        status: event.status,
        lastMessageId: event.lastMessageId ?? current.lastMessageId,
        resumeCount:
          current.status === "waiting_input" && event.status === "running"
            ? current.resumeCount + 1
            : current.resumeCount,
      };

      runs.set(event.runId, next);
      continue;
    }

    if (row.type === "worker_run_completed") {
      const event = parseExecutionEvent(row.data);
      if (!event || event.type !== "worker_run_completed") continue;

      const current = runs.get(event.runId);
      if (!current || !isValidTransition(current.status, "succeeded")) {
        continue;
      }

      const next: WorkerRunRecord = {
        ...current,
        status: "succeeded",
        endedAt: event.endedAt,
        lastMessageId: event.lastMessageId ?? current.lastMessageId,
      };

      runs.set(event.runId, next);
      continue;
    }

    if (row.type === "worker_run_failed") {
      const event = parseExecutionEvent(row.data);
      if (!event || event.type !== "worker_run_failed") continue;

      const current = runs.get(event.runId);
      if (!current || !isValidTransition(current.status, event.status)) {
        continue;
      }

      const next: WorkerRunRecord = {
        ...current,
        status: event.status,
        endedAt: event.endedAt,
      };

      runs.set(event.runId, next);
      continue;
    }

    // Legacy raw event handling for backward compatibility with old persisted data
    if (row.type === "worker_run.created") {
      const event = parseCreatedEvent(row.data);
      if (!event) continue;

      runs.set(event.runId, {
        runId: event.runId,
        sessionId,
        title: event.title,
        prompt: event.prompt,
        assignedStepId: event.assignedStepId,
        status: "queued",
        startedAt: event.startedAt,
        resumeCount: 0,
      });
      continue;
    }

    if (row.type !== "worker_run.status_updated") continue;

    const event = parseStatusUpdatedEvent(row.data);
    if (!event) continue;

    const current = runs.get(event.runId);
    if (!current || !isValidTransition(current.status, event.status)) {
      continue;
    }

    const next: WorkerRunRecord = {
      ...current,
      status: event.status,
      endedAt: event.endedAt ?? current.endedAt,
      lastMessageId: event.lastMessageId ?? current.lastMessageId,
      resumeCount:
        current.status === "waiting_input" && event.status === "running"
          ? current.resumeCount + 1
          : current.resumeCount,
    };

    runs.set(event.runId, next);
  }

  return runs;
}

function hasRun(sessionId: string, runId: string): Promise<WorkerRunRecord | undefined> {
  return WorkerRun.get(sessionId, runId);
}

export namespace WorkerRun {
  export async function create(
    sessionId: string,
    run: { runId: string; title: string; prompt: string; assignedStepId?: string },
  ): Promise<void> {
    if (await hasRun(sessionId, run.runId)) {
      throw new Error(`Worker run ${run.runId} already exists in session ${sessionId}`);
    }

    const now = new Date().toISOString();
    const actionId = `${sessionId}:worker_run_created:${run.runId}`;
    const event: ExecutionEvent.WorkerRunCreated = {
      type: "worker_run_created",
      runId: run.runId,
      title: run.title,
      prompt: run.prompt,
      assignedStepId: run.assignedStepId,
      startedAt: Date.now(),
      actionId,
      visibility: "internal",
      timestamp: now,
      sequence: 0,
    };
    appendExecutionEvent(sessionId, event);
  }

  export async function get(
    sessionId: string,
    runId: string,
  ): Promise<WorkerRunRecord | undefined> {
    return replayRuns(sessionId).get(runId);
  }

  export async function listBySession(sessionId: string): Promise<WorkerRunRecord[]> {
    return Array.from(replayRuns(sessionId).values());
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

    if (!isValidTransition(current.status, status)) {
      throw new Error(`Invalid worker run status transition from ${current.status} to ${status}`);
    }

    const now = new Date().toISOString();
    const actionId = `${sessionId}:worker_run_${status}:${runId}`;

    if (status === "succeeded") {
      const event: ExecutionEvent.WorkerRunCompleted = {
        type: "worker_run_completed",
        runId,
        status: "succeeded",
        endedAt: extra?.endedAt,
        lastMessageId: extra?.lastMessageId,
        actionId,
        visibility: "internal",
        timestamp: now,
        sequence: 0,
      };
      appendExecutionEvent(sessionId, event);
    } else if (status === "failed" || status === "cancelled" || status === "interrupted") {
      const event: ExecutionEvent.WorkerRunFailed = {
        type: "worker_run_failed",
        runId,
        status,
        error: extra?.error,
        endedAt: extra?.endedAt,
        actionId,
        visibility: "internal",
        timestamp: now,
        sequence: 0,
      };
      appendExecutionEvent(sessionId, event);
    } else if (status === "starting" || status === "running" || status === "waiting_input") {
      const event: ExecutionEvent.WorkerRunStatusChanged = {
        type: "worker_run_status_changed",
        runId,
        status,
        lastMessageId: extra?.lastMessageId,
        actionId,
        visibility: "internal",
        timestamp: now,
        sequence: 0,
      };
      appendExecutionEvent(sessionId, event);
    }

    if (current.status !== status) {
      publishLifecycleEvent(sessionId, current, status, extra?.error);
    }
  }
}
