import type { Storage as ProtocolStorage, WorkItem } from "@openomni/protocol";
import type { Storage } from "../storage/storage.js";
import type { WorkItemFact } from "./facts.js";

export type WorkItemAdapter = NonNullable<Storage.Adapter["workItem"]>;

export type CreateWorkItemInput = {
  name: string;
  sourceMessageId: string;
  sourceChannel: string;
  intent: string;
  goal: string;
  assigneeId?: string;
  sessionId?: string;
  context?: string;
  constraints?: string[];
  acceptanceCriteria: string[];
  parentId?: string;
  dependsOn?: string[];
  originSessionId?: string;
  workSessionId?: string;
  workerRunId?: string;
  executorKind?: WorkItem.ExecutorKind;
  maxAttempts?: number;
};

export type WorkItemListFilter = ProtocolStorage.WorkItemListFilter;

export type WorkItemTransitionTarget = "started" | "completed" | "failed" | "cancelled";

export type WorkItemMutation = {
  updated: WorkItem.Info;
  changedFields: string[];
  /** Decision-class fact appended before the projection CAS (#510 C1). */
  fact: WorkItemFact;
  target?: WorkItemTransitionTarget;
  /**
   * Receives the mutation's traceId (D11): every publish for one state
   * transition — StatusChanged, Updated, and any afterPublish event — carries
   * the caller's ONE trace, never a per-publish mint.
   */
  afterPublish?: (updated: WorkItem.Info, traceId: string) => void;
};
