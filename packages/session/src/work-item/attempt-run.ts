import { WorkItem, type WorkerRun } from "@openomni/protocol";
import { Storage } from "../storage/storage.js";
import { WorkerRunStateStore } from "../worker-run/state-store.js";
import { WorkItemRevisionError, WorkItemUnavailableError } from "./facts.js";
import { mutate } from "./mutation.js";

/**
 * #510 D2b — the run-lifecycle read/write surface over WorkItem attempt
 * facts, replacing the retired worker-run second ledger. Every write is a
 * decision-class fact on the `work:<hash>` owner stream through the existing
 * head==revision transaction (facts.ts); status transition legality stays in
 * the existing work-item fold (deriveStatus + assertTransition + the
 * attempt-allocation watermark) — the worker-run transition table is NOT
 * re-implemented. Honest state mapping (legacy worker-run status → fold):
 *
 *   queued/starting/running → attempt allocated on a started item ("running";
 *                             the starting/running distinction had no
 *                             decision content and folds away)
 *   waiting_input           → unresolved `waiting_input` blocker carrying the
 *                             `attempt-wait:<attemptId>` marker
 *   succeeded               → attemptTerminal.outcome "succeeded" (completion
 *                             admission remains the separate #490 verdict)
 *   failed                  → attemptTerminal "failed" + work_item failed
 *   cancelled               → attemptTerminal "cancelled" + work_item cancelled
 *   interrupted             → attemptTerminal "interrupted" + work_item failed
 *
 * Frozen legacy `worker_run_state` rows stay readable through the
 * deterministic upcast in {@link find}: terminal statuses map 1:1; a
 * non-terminal legacy status upcasts to "interrupted" because no live
 * process can be executing a pre-freeze run.
 */

const ATTEMPT_WAIT_PREFIX = "attempt-wait:";

export type AttemptRunStatus = "running" | "waiting_input" | WorkItem.AttemptOutcome;

export interface AttemptRunView {
  readonly runId: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly workItemHash?: string;
  readonly attemptId?: string;
  readonly executorKind?: WorkItem.ExecutorKind;
  readonly status: AttemptRunStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly source: "attempt_facts" | "worker_run_upcast";
}

type AttemptRunTerminalExtra = Readonly<{
  endedAt?: number;
  error?: string;
}>;

/** Acquire/finish contention resolves as "not acquired", never as a crash. */
class AttemptRunNotActiveError extends Error {
  readonly name = "AttemptRunNotActiveError";
}

// Recorded #494 performance item (do not optimize here): this is an O(N)
// full-table scan per lookup, and succeeded ingress runs accumulate as
// forever-"running" work items (no admission path closes them), so N grows
// unboundedly with ingress dispatch volume. #494 owns the indexed lookup
// (workSessionId/workerRunId filter) and the terminal-state janitor.
function findItem(sessionId: string, runId: string): WorkItem.Info | undefined {
  return Storage.get()
    .workItem?.list()
    .find((item) => item.workSessionId === sessionId && item.workerRunId === runId);
}

function openAttemptWaitBlocker(item: WorkItem.Info): WorkItem.Blocker | undefined {
  return item.blockers.find(
    (blocker) =>
      blocker.resolvedAt === undefined &&
      blocker.kind === "waiting_input" &&
      blocker.description.startsWith(ATTEMPT_WAIT_PREFIX),
  );
}

function isTerminalItem(item: WorkItem.Info): boolean {
  const status = WorkItem.deriveStatus(item);
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isActiveItem(item: WorkItem.Info): boolean {
  return (
    item.currentAttemptId !== undefined &&
    item.attemptTerminal === undefined &&
    !isTerminalItem(item)
  );
}

function statusOfItem(item: WorkItem.Info): AttemptRunStatus {
  if (item.attemptTerminal) return item.attemptTerminal.outcome;
  const status = WorkItem.deriveStatus(item);
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return openAttemptWaitBlocker(item) ? "waiting_input" : "running";
}

function endedAtOfItem(item: WorkItem.Info): number | undefined {
  if (item.attemptTerminal) return item.attemptTerminal.endedAt;
  return item.timestamps.failed ?? item.timestamps.cancelled ?? item.timestamps.completed;
}

function viewOfItem(item: WorkItem.Info): AttemptRunView {
  if (item.workerRunId === undefined || item.workSessionId === undefined) {
    throw new Error(`WorkItem has no run assignment: ${item.hash}`);
  }
  return {
    runId: item.workerRunId,
    sessionId: item.workSessionId,
    parentSessionId: item.originSessionId,
    workItemHash: item.hash,
    attemptId: item.currentAttemptId,
    executorKind: item.executorKind,
    status: statusOfItem(item),
    startedAt: item.timestamps.started ?? item.timestamps.created,
    endedAt: endedAtOfItem(item),
    error: item.attemptTerminal?.error ?? item.failureReason,
    source: "attempt_facts",
  };
}

const legacyTerminalStatuses: ReadonlySet<WorkerRun.Status> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Deterministic upcast of one frozen `worker_run_state` row. Read-only: the
 * same archived row always produces the same view, and nothing is
 * materialized as an active run — a non-terminal legacy status folds to
 * "interrupted" (the freeze shipped with a restart, so no live process can
 * still be executing it).
 */
function viewOfLegacyRow(record: WorkerRunStateStore.Record): AttemptRunView {
  const terminal = legacyTerminalStatuses.has(record.status);
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    parentSessionId: record.parentSessionId,
    executorKind: record.executorKind,
    status: terminal ? (record.status as AttemptRunStatus) : "interrupted",
    startedAt: record.timeCreated,
    endedAt: record.timeUpdated,
    error: terminal
      ? record.error
      : (record.error ??
        "worker_run frozen (#510 D2b): a legacy run cannot outlive the freeze restart"),
    source: "worker_run_upcast",
  };
}

async function mutateRun(
  sessionId: string,
  runId: string,
  build: Parameters<typeof mutate>[1],
): Promise<boolean> {
  const item = findItem(sessionId, runId);
  if (!item) return false;
  try {
    return (await mutate(item.hash, build)) !== undefined;
  } catch (error) {
    // Contention (a concurrent transition won the head) and losing the
    // acquire race both mean "not acquired/finished" — the caller retries
    // from a fresh read or reports the run as no longer active.
    if (
      error instanceof AttemptRunNotActiveError ||
      error instanceof WorkItemRevisionError ||
      error instanceof WorkItemUnavailableError
    ) {
      return false;
    }
    throw error;
  }
}

export namespace WorkItemAttemptRun {
  /**
   * The run view for (workSessionId, runId): the WorkItem attempt projection
   * when one exists, else the deterministic upcast of a frozen legacy
   * `worker_run_state` row.
   */
  export function find(sessionId: string, runId: string): AttemptRunView | undefined {
    const item = findItem(sessionId, runId);
    if (item) return viewOfItem(item);
    const legacy = WorkerRunStateStore.get(sessionId, runId);
    return legacy ? viewOfLegacyRow(legacy) : undefined;
  }

  /**
   * Active runs (attempt allocated, not finished, item not terminal) from
   * attempt facts only — frozen legacy rows are never active by definition.
   */
  export function listActive(sessionId?: string): AttemptRunView[] {
    return (Storage.get().workItem?.list() ?? [])
      .filter(
        (item) =>
          item.workerRunId !== undefined &&
          item.workSessionId !== undefined &&
          (sessionId === undefined || item.workSessionId === sessionId) &&
          isActiveItem(item),
      )
      .map(viewOfItem);
  }

  /**
   * Acquires the run's inbound wait: appends the `waiting_input` blocker
   * fact carrying the `attempt-wait:<attemptId>` marker. Returns false when
   * the run is missing, not active, already waiting, or a concurrent
   * transition wins the head CAS — the acquire semantics the retired
   * worker-run `updateStatusIfCurrent(running -> waiting_input)` provided.
   */
  export async function beginWait(sessionId: string, runId: string): Promise<boolean> {
    return mutateRun(sessionId, runId, (existing, now) => {
      if (!isActiveItem(existing) || openAttemptWaitBlocker(existing)) {
        throw new AttemptRunNotActiveError();
      }
      const blocker: WorkItem.Blocker = {
        id: crypto.randomUUID(),
        kind: "waiting_input",
        description: `${ATTEMPT_WAIT_PREFIX}${existing.currentAttemptId} is waiting for inbound input`,
        createdAt: now,
      };
      return {
        changedFields: ["blockers"],
        fact: {
          type: "work_item.blocker_added",
          data: { blockerId: blocker.id, kind: blocker.kind, description: blocker.description },
        },
        updated: {
          ...existing,
          blockers: [...existing.blockers, blocker],
          timestamps: { ...existing.timestamps, updated: now },
        },
      };
    });
  }

  /** Releases the inbound wait (resolves the attempt-wait blocker). */
  export async function endWait(sessionId: string, runId: string): Promise<boolean> {
    return mutateRun(sessionId, runId, (existing, now) => {
      const open = openAttemptWaitBlocker(existing);
      if (!open) throw new AttemptRunNotActiveError();
      return {
        changedFields: ["blockers"],
        fact: {
          type: "work_item.blocker_resolved",
          data: { blockerId: open.id, resolvedAt: now },
        },
        updated: {
          ...existing,
          blockers: existing.blockers.map((blocker) =>
            blocker.id === open.id ? { ...blocker, resolvedAt: now } : blocker,
          ),
          timestamps: { ...existing.timestamps, updated: now },
        },
      };
    });
  }

  /**
   * Records the attempt's terminal outcome as ONE `work_item.attempt_finished`
   * fact: the attemptTerminal projection (outcome, endedAt, error — durable
   * where the worker-run store kept in-memory extras), the honest work-item
   * fold (failed/interrupted → failed timestamps + failureReason, cancelled
   * → cancelled timestamp), and the release of any open attempt wait.
   * Returns false when the run is missing or its terminal record already
   * exists (idempotent-finish semantics for recovery and cancel races). One
   * deliberate exception to the active-run guard: a work item COMPLETED by
   * completion admission may still record its attempt's `succeeded` terminal
   * — admission landing before the terminal fact is the normal worker.
   * complete order, not a dead run.
   */
  export async function finish(
    sessionId: string,
    runId: string,
    outcome: WorkItem.AttemptOutcome,
    extra: AttemptRunTerminalExtra = {},
  ): Promise<boolean> {
    return mutateRun(sessionId, runId, (existing, now) => {
      const completedSucceeded =
        outcome === "succeeded" &&
        existing.currentAttemptId !== undefined &&
        existing.attemptTerminal === undefined &&
        WorkItem.deriveStatus(existing) === "completed";
      if (
        (!isActiveItem(existing) || existing.currentAttemptId === undefined) &&
        !completedSucceeded
      ) {
        throw new AttemptRunNotActiveError();
      }
      const terminal = WorkItem.AttemptTerminal.parse({
        attemptId: existing.currentAttemptId,
        outcome,
        endedAt: extra.endedAt ?? now,
        ...(extra.error === undefined ? {} : { error: extra.error }),
      });
      const failed = outcome === "failed" || outcome === "interrupted";
      const cancelled = outcome === "cancelled";
      const open = openAttemptWaitBlocker(existing);
      return {
        changedFields: [
          "attemptTerminal",
          "timestamps",
          ...(failed ? ["failureReason"] : []),
          ...(open ? ["blockers"] : []),
        ],
        target: failed ? "failed" : cancelled ? "cancelled" : undefined,
        fact: { type: "work_item.attempt_finished", data: { ...terminal } },
        updated: {
          ...existing,
          attemptTerminal: terminal,
          failureReason: failed
            ? (extra.error ?? `worker run attempt ${outcome}`)
            : existing.failureReason,
          blockers: open
            ? existing.blockers.map((blocker) =>
                blocker.id === open.id ? { ...blocker, resolvedAt: now } : blocker,
              )
            : existing.blockers,
          timestamps: {
            ...existing.timestamps,
            ...(failed ? { failed: now } : {}),
            ...(cancelled ? { cancelled: now } : {}),
            updated: now,
          },
        },
      };
    });
  }
}
