import { WorkItem } from "@openomni/protocol";

export {
  CompletionAdmissionDriverScenarios,
  runCompletionAdmissionDriver,
} from "./completion-admission-driver.js";
export type {
  CompletionAdmissionDriverExecution,
  CompletionAdmissionDriverScenario,
} from "./completion-admission-driver.js";
export type { WorkItemCompletionRecoveryReceipt } from "./completion-admission.js";

export const CompletionSourceOrigin = WorkItem.CompletionSourceOrigin;
export type CompletionSourceOrigin = WorkItem.CompletionSourceOrigin;

export function projectCompletionOrigin(input: unknown): WorkItem.CompletionOrigin {
  return WorkItem.projectCompletionOrigin(WorkItem.CompletionSourceOrigin.parse(input));
}
