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

function appendEvent(sessionId: string, type: string, data: object): void {
  const adapter = getAdapter();
  if (adapter) {
    adapter.append(sessionId, type, JSON.stringify(data));
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

function replayRuns(sessionId: string): Map<string, WorkerRunRecord> {
  const adapter = getAdapter();
  const runs = new Map<string, WorkerRunRecord>();

  if (!adapter) {
    return runs;
  }

  for (const row of adapter.replay(sessionId)) {
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

    appendEvent(sessionId, "worker_run.created", {
      runId: run.runId,
      title: run.title,
      prompt: run.prompt,
      assignedStepId: run.assignedStepId,
      startedAt: Date.now(),
    });
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
    extra?: { endedAt?: number; lastMessageId?: string },
  ): Promise<void> {
    const current = await get(sessionId, runId);
    if (!current) {
      throw new Error(`Worker run ${runId} not found in session ${sessionId}`);
    }

    if (!isValidTransition(current.status, status)) {
      throw new Error(`Invalid worker run status transition from ${current.status} to ${status}`);
    }

    appendEvent(sessionId, "worker_run.status_updated", {
      runId,
      status,
      endedAt: extra?.endedAt,
      lastMessageId: extra?.lastMessageId,
    });
  }
}
