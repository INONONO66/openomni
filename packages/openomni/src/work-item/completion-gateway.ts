import { WorkItem } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import type { CompletionAuthorityDependencies } from "./completion-admission-authority.js";
import { createCompletionAuthorityResolver } from "./completion-admission-authority.js";
import {
  type CompletionAdmissionService,
  createCompletionAdmissionService,
} from "./completion-admission-boundary.js";

export type WorkItemCompletionGatewayOptions = CompletionAuthorityDependencies &
  Readonly<{ completionWriter: Storage.WorkItemCompletionWriter }>;
export type WorkItemCompletionRecoveryReceipt = Readonly<{
  recovered: number;
  skipped: number;
  failures: readonly Readonly<{
    workItemHash: string;
    admissionId: string;
    error: string;
  }>[];
}>;
export type WorkItemCompletionGateway = CompletionAdmissionService &
  Readonly<{
    recoverRecordedCompletions(): Promise<WorkItemCompletionRecoveryReceipt>;
  }>;

export function createWorkItemCompletionGateway(
  options: WorkItemCompletionGatewayOptions,
): WorkItemCompletionGateway {
  const now = options.now ?? Date.now;
  const service = createCompletionAdmissionService({
    completionWriter: options.completionWriter,
    authorityResolver: createCompletionAuthorityResolver(options),
    allowTrustedInvalidations: options.invalidationAuthorityPort !== undefined,
    now,
  });
  return Object.freeze({
    ...service,
    async recoverRecordedCompletions() {
      const adapter = Storage.get().workItem;
      if (!adapter) return { recovered: 0, skipped: 0, failures: [] };
      let recovered = 0;
      let skipped = 0;
      const failures: Array<{
        workItemHash: string;
        admissionId: string;
        error: string;
      }> = [];
      for (const item of adapter.list()) {
        if (item.completionFacts.admissions.length === 0 || item.completionTerminalReceipt) {
          continue;
        }
        const admission = item.completionFacts.admissions
          .filter(
            (candidate) =>
              candidate.contractRevision === item.completionContract.revision &&
              candidate.basisRef === item.completionContract.basisRef,
          )
          .at(-1);
        if (
          !admission ||
          (admission.decision !== "admit" && admission.decision !== "owner_override") ||
          admission.completionReportSnapshot === undefined ||
          ["completed", "failed", "cancelled"].includes(WorkItem.deriveStatus(item))
        ) {
          skipped += 1;
          continue;
        }
        try {
          const recoveredItem = await service.resumeCompletion(
            item.hash,
            admission.id,
            admission.completionReportSnapshot,
          );
          if (WorkItem.deriveStatus(recoveredItem) === "completed") {
            recovered += 1;
          } else {
            failures.push({
              workItemHash: item.hash,
              admissionId: admission.id,
              error: "completion recovery remained incomplete",
            });
          }
        } catch (error) {
          failures.push({
            workItemHash: item.hash,
            admissionId: admission.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { recovered, skipped, failures };
    },
  });
}
