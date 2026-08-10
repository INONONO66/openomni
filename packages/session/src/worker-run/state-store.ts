import { WorkerRun, type WorkItem } from "@openomni/protocol";
import { z } from "zod";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";

/**
 * #510 D2b — WorkerRunStateStore is FROZEN: every write surface throws the
 * typed `WorkerRun.FrozenError` and persists nothing (the worker-run
 * transition table died with the writes — run transition legality lives in
 * the WorkItem fold). Reads keep serving the immutable historical
 * `worker_run_state` rows for the upcast-on-read attempt-run view and the
 * archive manifest. Historical rows are seeded in tests at the adapter
 * layer, exactly as pre-freeze rows persist on disk.
 */

function requireAdapter(): WorkerRunStateStore.Adapter {
  return requireSubAdapter(
    Storage.get().workerRunState,
    "Storage adapter does not implement workerRunState",
  );
}

function frozenWrite(method: WorkerRun.WriteMethod): never {
  throw new WorkerRun.FrozenError({
    message: `WorkerRunStateStore is frozen (#510 D2b): ${method} is retired — historical worker_run_state rows are read-only archive`,
    code: "worker_run_frozen",
    method,
  });
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

  export function create(_sessionId: string, _record: CreateRecord): never {
    frozenWrite("create");
  }

  export function updateStatus(
    _sessionId: string,
    _runId: string,
    _status: Status,
    _extra?: StatusExtra,
  ): never {
    frozenWrite("updateStatus");
  }

  export function updateStatusIfCurrent(
    _sessionId: string,
    _runId: string,
    _expected: StatusPrecondition,
    _status: Status,
    _extra?: StatusExtra,
  ): never {
    frozenWrite("updateStatusIfCurrent");
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
