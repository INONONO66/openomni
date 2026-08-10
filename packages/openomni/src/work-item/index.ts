import { WorkItem } from "@openomni/protocol";

export type { WorkItemCompletionRecoveryReceipt } from "./completion-admission.js";

export const CompletionSourceOrigin: typeof WorkItem.CompletionSourceOrigin =
  WorkItem.CompletionSourceOrigin;
export type CompletionSourceOrigin = WorkItem.CompletionSourceOrigin;

export function projectCompletionOrigin(input: unknown): WorkItem.CompletionOrigin {
  return WorkItem.projectCompletionOrigin(WorkItem.CompletionSourceOrigin.parse(input));
}
