import type { Storage as ProtocolStorage, WorkItem } from "@openomni/protocol";
import type { Storage } from "../storage/storage.js";

export type WorkItemAdapter = NonNullable<Storage.Adapter["workItem"]>;

export type DependencyReadiness = {
  met: boolean;
  reason: "all_complete" | "pending" | "failed" | "blocked";
};

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
  acceptanceCriteria?: string[];
  parentHash?: string;
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
  target?: WorkItemTransitionTarget;
  afterPublish?: (updated: WorkItem.Info) => void;
};
