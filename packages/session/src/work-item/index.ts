import type { WorkItem } from "@openomni/protocol";
import { createWorkItem } from "./create.js";
import { getWorkItem, listWorkItems, removeWorkItem, updateWorkItem } from "./crud.js";
import {
  addWorkItemBlocker,
  addWorkItemEvidence,
  addWorkItemReadBackEvidence,
  areDependenciesMet as areStoredDependenciesMet,
  cancelWorkItem,
  completeWorkItem,
  failWorkItem,
  recordOutcome as recordWorkItemOutcome,
  resolveWorkItemBlocker,
  retryStoredWorkItem,
  startWorkItem,
} from "./lifecycle.js";
import type { CreateWorkItemInput, DependencyReadiness, WorkItemListFilter } from "./types.js";

export namespace WorkItemStore {
  export async function create(input: CreateWorkItemInput): Promise<WorkItem.Info> {
    return createWorkItem(input);
  }

  export function get(hash: string): WorkItem.Info | undefined {
    return getWorkItem(hash);
  }

  export function list(filter?: WorkItemListFilter): WorkItem.Info[] {
    return listWorkItems(filter);
  }

  export function remove(hash: string): boolean {
    return removeWorkItem(hash);
  }

  export async function update(
    hash: string,
    fields: Partial<Omit<WorkItem.Info, "hash">>,
  ): Promise<WorkItem.Info | undefined> {
    return updateWorkItem(hash, fields);
  }

  export async function start(hash: string): Promise<WorkItem.Info | undefined> {
    return startWorkItem(hash);
  }

  export async function complete(
    hash: string,
    completionReport: WorkItem.CompletionReport,
  ): Promise<WorkItem.Info | undefined> {
    return completeWorkItem(hash, completionReport);
  }

  export async function fail(hash: string, reason?: string): Promise<WorkItem.Info | undefined> {
    return failWorkItem(hash, reason);
  }

  export async function cancel(hash: string): Promise<WorkItem.Info | undefined> {
    return cancelWorkItem(hash);
  }

  export async function addBlocker(
    hash: string,
    blocker: Omit<WorkItem.Blocker, "id" | "createdAt">,
  ): Promise<WorkItem.Info | undefined> {
    return addWorkItemBlocker(hash, blocker);
  }

  export async function resolveBlocker(
    hash: string,
    blockerId: string,
  ): Promise<WorkItem.Info | undefined> {
    return resolveWorkItemBlocker(hash, blockerId);
  }

  export async function addEvidence(
    hash: string,
    evidence: Omit<WorkItem.Evidence, "id" | "createdAt"> & Readonly<{ id?: string }>,
  ): Promise<WorkItem.Info | undefined> {
    return addWorkItemEvidence(hash, evidence);
  }

  export async function addReadBackEvidence(
    hash: string,
    check: WorkItem.ReadBackCheck,
  ): Promise<WorkItem.Info | undefined> {
    return addWorkItemReadBackEvidence(hash, check);
  }

  export const recordOutcome = recordWorkItemOutcome;

  export function areDependenciesMet(hash: string): DependencyReadiness {
    return areStoredDependenciesMet(hash);
  }

  export async function retry(hash: string): Promise<WorkItem.Info | undefined> {
    return retryStoredWorkItem(hash);
  }
}
