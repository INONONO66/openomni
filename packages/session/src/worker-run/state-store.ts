import type { Subagent } from "@openomni/protocol";
import { Storage } from "../storage/storage";

const transitions: Record<Subagent.WorkerRunStatus, readonly Subagent.WorkerRunStatus[]> = {
  queued: ["starting"],
  starting: ["running"],
  running: ["waiting_input", "succeeded", "failed", "cancelled", "interrupted"],
  waiting_input: ["running"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

function isValidTransition(
  current: Subagent.WorkerRunStatus,
  next: Subagent.WorkerRunStatus,
): boolean {
  return current === next || transitions[current].includes(next);
}

function requireAdapter(): WorkerRunStateStore.Adapter {
  const adapter = Storage.get().workerRunState;
  if (!adapter) {
    throw new Error("Storage adapter does not implement workerRunState");
  }
  return adapter;
}

export namespace WorkerRunStateStore {
  export type Status = Subagent.WorkerRunStatus;

  export interface Record {
    readonly runId: string;
    readonly sessionId: string;
    readonly parentSessionId?: string;
    readonly agentName: string;
    readonly status: Status;
    readonly title: string;
    readonly prompt: string;
    readonly resumeCount: number;
    readonly assignedStepId?: string;
    readonly error?: string;
    readonly timeCreated: number;
    readonly timeUpdated: number;
  }

  export type CreateRecord = Omit<
    Record,
    "sessionId" | "resumeCount" | "timeCreated" | "timeUpdated"
  > &
    Partial<Pick<Record, "resumeCount" | "timeCreated" | "timeUpdated">>;

  export interface StatusExtra {
    readonly error?: string;
  }

  export interface Adapter {
    create(sessionId: string, record: CreateRecord): void;
    updateStatus(sessionId: string, runId: string, status: Status, extra?: StatusExtra): boolean;
    get(sessionId: string, runId: string): Record | undefined;
    listBySession(sessionId: string): Record[];
    listByStatus(status: Status): Record[];
  }

  export function create(sessionId: string, record: CreateRecord): void {
    if (requireAdapter().get(sessionId, record.runId)) {
      throw new Error(`Worker run ${record.runId} already exists in session ${sessionId}`);
    }
    requireAdapter().create(sessionId, record);
  }

  export function updateStatus(
    sessionId: string,
    runId: string,
    status: Status,
    extra?: StatusExtra,
  ): void {
    const adapter = requireAdapter();
    const current = adapter.get(sessionId, runId);
    if (!current) {
      throw new Error(`Worker run ${runId} not found in session ${sessionId}`);
    }
    if (!isValidTransition(current.status, status)) {
      throw new Error(`Invalid worker run status transition from ${current.status} to ${status}`);
    }
    adapter.updateStatus(sessionId, runId, status, extra);
  }

  export function get(sessionId: string, runId: string): Record | undefined {
    return requireAdapter().get(sessionId, runId);
  }

  export function listBySession(sessionId: string): Record[] {
    return requireAdapter().listBySession(sessionId);
  }

  export function listByStatus(status: Status): Record[] {
    return requireAdapter().listByStatus(status);
  }
}
