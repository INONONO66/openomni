import { WorkItem } from "@openomni/protocol";

export const CompletionSourceOrigin: typeof WorkItem.CompletionSourceOrigin =
  WorkItem.CompletionSourceOrigin;
export type CompletionSourceOrigin = WorkItem.CompletionSourceOrigin;

export function projectCompletionOrigin(input: unknown): WorkItem.CompletionOrigin {
  return WorkItem.projectCompletionOrigin(WorkItem.CompletionSourceOrigin.parse(input));
}
