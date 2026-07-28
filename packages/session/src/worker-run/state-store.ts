import { WorkerRun, type WorkItem } from "@openomni/protocol";
import { z } from "zod";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";

const transitions: Record<WorkerRun.Status, readonly WorkerRun.Status[]> = {
  queued: ["starting"],
  starting: ["running", "failed", "cancelled", "interrupted"],
  running: ["waiting_input", "succeeded", "failed", "cancelled", "interrupted"],
  waiting_input: ["running", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

function isValidTransition(current: WorkerRun.Status, next: WorkerRun.Status): boolean {
  return current === next || transitions[current].includes(next);
}

function requireAdapter(): WorkerRunStateStore.Adapter {
  return requireSubAdapter(
    Storage.get().workerRunState,
    "Storage adapter does not implement workerRunState",
  );
}

export namespace WorkerRunStateStore {
  export type Status = WorkerRun.Status;

  export interface Record {
    readonly runId: string;
    readonly sessionId: string;
    readonly parentSessionId?: string;
    readonly agentName: string;
    readonly status: Status;
    readonly executorKind?: WorkItem.ExecutorKind;
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

  export const StatusPrecondition = z.object({
    status: WorkerRun.Status,
    timeUpdated: z.number(),
  });
  export type StatusPrecondition = z.infer<typeof StatusPrecondition>;

  export interface Adapter {
    create(sessionId: string, record: CreateRecord): void;
    updateStatus(sessionId: string, runId: string, status: Status, extra?: StatusExtra): boolean;
    updateStatusIfCurrent(
      sessionId: string,
      runId: string,
      expected: StatusPrecondition,
      status: Status,
      extra?: StatusExtra,
    ): boolean;
    get(sessionId: string, runId: string): Record | undefined;
    listBySession(sessionId: string): Record[];
    listByStatus(status: Status): Record[];
  }

  export function create(sessionId: string, record: CreateRecord): void {
    const adapter = requireAdapter();
    if (adapter.get(sessionId, record.runId)) {
      throw new Error(`Worker run ${record.runId} already exists in session ${sessionId}`);
    }
    adapter.create(sessionId, record);
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

  export function updateStatusIfCurrent(
    sessionId: string,
    runId: string,
    expected: StatusPrecondition,
    status: Status,
    extra?: StatusExtra,
  ): boolean {
    const parsedExpected = StatusPrecondition.parse(expected);
    if (!isValidTransition(parsedExpected.status, status)) {
      throw new Error(
        `Invalid worker run status transition from ${parsedExpected.status} to ${status}`,
      );
    }
    return requireAdapter().updateStatusIfCurrent(sessionId, runId, parsedExpected, status, extra);
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
