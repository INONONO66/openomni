import type { WorkItem } from "@openomni/protocol";
import { createWorkItem } from "./create.js";
import { recordWorkItemEffect, type RecordEffectInput } from "./effect-link.js";
import { getWorkItem, listWorkItems } from "./crud.js";
import {
  addWorkItemBlocker,
  addWorkItemEvidence,
  addWorkItemReadBackEvidence,
  allocateWorkItemAttempt,
  assignWorkItemExecution,
  cancelWorkItem,
  failWorkItem,
  resolveWorkItemBlocker,
  retryStoredWorkItem,
  startWorkItem,
  type AttemptAllocationInput,
} from "./lifecycle.js";
import type { CreateWorkItemInput, WorkItemListFilter } from "./types.js";

export namespace WorkItemStore {
  export async function create(
    input: CreateWorkItemInput,
    traceId: string,
  ): Promise<WorkItem.Info> {
    return createWorkItem(input, traceId);
  }

  export function get(hash: string): WorkItem.Info | undefined {
    return getWorkItem(hash);
  }

  export function list(filter?: WorkItemListFilter): WorkItem.Info[] {
    return listWorkItems(filter);
  }

  export async function start(hash: string, traceId: string): Promise<WorkItem.Info | undefined> {
    return startWorkItem(hash, traceId);
  }

  export async function assignExecution(
    hash: string,
    assignment: Readonly<{
      executorKind: WorkItem.ExecutorKind;
      workerRunId: string;
      workSessionId: string;
    }>,
    traceId: string,
  ): Promise<WorkItem.Info | undefined> {
    return assignWorkItemExecution(hash, assignment, traceId);
  }

  export async function fail(
    hash: string,
    traceId: string,
    reason?: string,
  ): Promise<WorkItem.Info | undefined> {
    return failWorkItem(hash, traceId, reason);
  }

  export async function cancel(hash: string, traceId: string): Promise<WorkItem.Info | undefined> {
    return cancelWorkItem(hash, traceId);
  }

  export async function addBlocker(
    hash: string,
    blocker: Omit<WorkItem.Blocker, "id" | "createdAt"> & Readonly<{ id?: string }>,
    traceId: string,
  ): Promise<WorkItem.Info | undefined> {
    return addWorkItemBlocker(hash, blocker, traceId);
  }

  export async function resolveBlocker(
    hash: string,
    blockerId: string,
    traceId: string,
  ): Promise<WorkItem.Info | undefined> {
    return resolveWorkItemBlocker(hash, blockerId, traceId);
  }

  export async function addEvidence(
    hash: string,
    evidence: Parameters<typeof addWorkItemEvidence>[1],
    traceId: string,
    expectedScope?: Readonly<{ expectedAttempt: number; expectedBasisRef: string }>,
  ): Promise<WorkItem.Info | undefined> {
    return addWorkItemEvidence(hash, evidence, traceId, expectedScope);
  }

  export async function addReadBackEvidence(
    hash: string,
    check: WorkItem.ReadBackCheck,
    traceId: string,
    expectedScope?: Readonly<{
      expectedAttempt: number;
      expectedBasisRef: string;
      criterionId: string;
      evidenceId?: string;
    }>,
  ): Promise<WorkItem.Info | undefined> {
    return addWorkItemReadBackEvidence(hash, check, traceId, expectedScope);
  }

  /**
   * #492 ↔ #490 — projects one effect intent's state onto the WorkItem's
   * completion facts so admission blocks until the effect reaches a terminal
   * outcome. Called by the OpenOmni effect service/reconciler; the durable
   * effect audit lives on the `effect:<effectId>` stream.
   */
  export function recordEffect(hash: string, input: RecordEffectInput): WorkItem.Info | undefined {
    return recordWorkItemEffect(hash, input);
  }

  /**
   * No production caller reaches retry today (dispatch does not re-drive
   * failed items yet); it stays because multi-attempt admission flows are
   * pinned through it (packages/openomni completion-admission tests) and it
   * is the only writer of the attempt/basisRef advance on a failed item.
   */
  export async function retry(hash: string, traceId: string): Promise<WorkItem.Info | undefined> {
    return retryStoredWorkItem(hash, traceId);
  }

  /**
   * #510 C2 — appends `work_item.attempt_allocated` (full Attempt identity)
   * on the owner stream before the projection advances; attemptSeq is
   * allocated by that serialized append and never reused.
   */
  export async function allocateAttempt(
    hash: string,
    identity: AttemptAllocationInput,
    traceId: string,
  ): Promise<Readonly<{ item: WorkItem.Info; attempt: WorkItem.Attempt }> | undefined> {
    return allocateWorkItemAttempt(hash, identity, traceId);
  }
}
