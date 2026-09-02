import type { WorkItem } from "@openomni/protocol";
import { createWorkItem } from "./create.js";
import { getWorkItem, listWorkItems } from "./crud.js";
import {
  addWorkItemEvidence,
  allocateWorkItemAttempt,
  assignWorkItemExecution,
  cancelWorkItem,
  failWorkItem,
  startWorkItem,
  type AttemptAllocationInput,
} from "./lifecycle.js";
import type { CreateWorkItemInput, WorkItemListFilter } from "./types.js";
import {
  appendVerificationFacts as appendFacts,
  type VerificationFactsInput,
  type VerificationFactsOutcome,
} from "./verification-facts.js";

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

  export async function addEvidence(
    hash: string,
    evidence: Parameters<typeof addWorkItemEvidence>[1],
    traceId: string,
    expectedScope?: Readonly<{ expectedAttempt: number; expectedBasisRef: string }>,
  ): Promise<WorkItem.Info | undefined> {
    return addWorkItemEvidence(hash, evidence, traceId, expectedScope);
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

  export function appendVerificationFacts(
    hash: string,
    input: VerificationFactsInput,
    traceId: string,
  ): VerificationFactsOutcome {
    return appendFacts(hash, input, traceId);
  }
}
