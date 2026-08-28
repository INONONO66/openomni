import { NamedError, type WorkItem } from "@openomni/protocol";
import { z } from "zod";
import { frozenWriteRefusal } from "../storage/frozen";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";

/**
 * #510 D2b / #498 K1 — WorkerRunStateStore is FROZEN and session-internal:
 * every write surface throws the typed `WorkerRunFrozenError` and persists
 * nothing (the worker-run transition table died with the writes — run
 * transition legality lives in the WorkItem fold). Reads keep serving the
 * immutable historical `worker_run_state` rows for the upcast-on-read
 * attempt-run view and the archive manifest. Historical rows are seeded in
 * tests at the adapter layer, exactly as pre-freeze rows persist on disk.
 *
 * The frozen vocabulary (Status/WriteMethod/FrozenError) lives HERE — the
 * protocol `worker-run` namespace was retired with #498 (absorption into
 * WorkItem attempts); this module is the archive's one owner.
 */

function requireAdapter(): WorkerRunStateStore.Adapter {
  return requireSubAdapter(
    Storage.get().workerRunState,
    "Storage adapter does not implement workerRunState",
  );
}

export namespace WorkerRunStateStore {
  /** Legacy run-status vocabulary of the frozen `worker_run_state` archive. */
  export const Status = z.enum([
    "queued",
    "starting",
    "running",
    "waiting_input",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  export type Status = z.infer<typeof Status>;

  export const WriteMethod = z.enum(["create", "updateStatus", "updateStatusIfCurrent"]);
  export type WriteMethod = z.infer<typeof WriteMethod>;

  /**
   * #510 D2b — worker-run is a frozen legacy writer. Its live production
   * consumers cut over to WorkItem attempt facts (`work_item.attempt_*` on
   * the `work:<workItemId>` owner stream), so every worker-run store write
   * method throws this typed error. Callers branch on `data.code`, never
   * message text. Historical `worker_run_state` rows stay readable through
   * the store's read methods and the upcast-on-read attempt-run view; the
   * archive manifest (script/generate-ledger-archive-manifest.ts) records
   * their range identity and integrity hash.
   */
  export const FrozenError = NamedError.create(
    "WorkerRunFrozenError",
    z.object({
      message: z.string(),
      code: z.literal("worker_run_frozen"),
      method: WriteMethod,
    }),
  );
  export type FrozenError = InstanceType<typeof FrozenError>;

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

  // Non-exported: only the frozen write signatures below reference these —
  // their last external consumers died with the adapter update branches
  // (#498 K1).
  interface StatusExtra {
    readonly error?: string;
  }

  interface StatusPrecondition {
    readonly status: Status;
    readonly timeUpdated: number;
  }

  export interface Adapter {
    /** @internal Archive seeding only (tests/tooling) — see the adapter module doc. */
    create(sessionId: string, record: CreateRecord): void;
    get(sessionId: string, runId: string): Record | undefined;
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
}

// Declared after the namespace because the FrozenError class it closes over
// is defined inside it; the namespace's write methods only call it at
// invocation time, so module-evaluation order is safe. Explicit annotation
// required: TS only treats the call as never-returning (TS2534) when the
// variable carries an explicit `=> never` type.
const frozenWrite: (method: WorkerRunStateStore.WriteMethod) => never = frozenWriteRefusal(
  WorkerRunStateStore.FrozenError,
  "worker_run_frozen",
  (method: WorkerRunStateStore.WriteMethod) =>
    `WorkerRunStateStore is frozen (#510 D2b): ${method} is retired — historical worker_run_state rows are read-only archive`,
);
