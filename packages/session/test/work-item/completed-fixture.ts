import { WorkItem } from "@openomni/protocol";
import { Bus, Storage } from "../../src";

export function persistCompletedWorkItemFixture(input: {
  readonly hash: string;
  readonly report: WorkItem.CompletionReport;
  readonly completionWriter: Storage.WorkItemCompletionWriter;
  readonly publishTerminalEvents?: boolean;
}): WorkItem.Info | undefined {
  const workItemAdapter = Storage.get().workItem;
  const current = workItemAdapter?.get(input.hash);
  if (!workItemAdapter || !current) return undefined;
  const completionReport = WorkItem.canonicalCompletionReport(input.report);
  const completionReportRef = WorkItem.completionReportReference(completionReport);
  const requestId = `completion-request:${input.hash}:${current.revision}:session-fixture`;
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${input.hash}:${current.revision + 1}:session-fixture`,
    requestId,
    requestSnapshot: WorkItem.CompletionRequest.parse({
      version: 1,
      id: requestId,
      origin: "recovery",
      workItemHash: input.hash,
      contractRevision: current.completionContract.revision,
      basisRef: current.completionContract.basisRef,
      expectedHead: current.revision,
      claims: [],
      observations: [],
      results: [],
      invalidations: [],
      verificationErrors: [],
      effects: [],
    }),
    origin: "recovery",
    contractRevision: current.completionContract.revision,
    basisRef: current.completionContract.basisRef,
    effectiveResultIds: [],
    unresolvedCriterionIds: [],
    decision: "admit",
    reasonCodes: ["session_completed_fixture"],
    residualRisks: [],
    policyRef: "policy:session-completed-fixture",
    completionReportSnapshot: completionReport,
    completionReportRef,
    expectedHead: current.revision,
    recordedHead: current.revision + 1,
    createdAt: current.timestamps.updated + 1,
  });
  const admitted = WorkItem.Info.parse({
    ...current,
    revision: admission.recordedHead,
    completionFacts: {
      ...current.completionFacts,
      revision: current.completionFacts.revision + 1,
      admissions: [...current.completionFacts.admissions, admission],
    },
    timestamps: { ...current.timestamps, updated: admission.createdAt },
  });
  if (!input.completionWriter(input.hash, current.revision, admitted)) return undefined;

  const completedAt = admission.createdAt + 1;
  const receipt: WorkItem.CompletionTerminalReceipt = {
    version: 1,
    hash: input.hash,
    requestId,
    admissionId: admission.id,
    contractRevision: admission.contractRevision,
    basisRef: admission.basisRef,
    completionReportRef,
    recordedHead: admitted.revision + 1,
  };
  const completed = WorkItem.Info.parse({
    ...admitted,
    revision: admitted.revision + 1,
    completionReport,
    completionTerminalReceipt: receipt,
    timestamps: { ...admitted.timestamps, completed: completedAt, updated: completedAt },
  });
  if (!input.completionWriter(input.hash, admitted.revision, completed)) return undefined;

  if (input.publishTerminalEvents) {
    Bus.publish(WorkItem.Events.StatusChanged, {
      traceId: "trace-session-completed-fixture",
      time: completedAt,
      sessionId: completed.sessionId,
      payload: { hash: input.hash, from: WorkItem.deriveStatus(admitted), to: "completed" },
    });
    Bus.publish(WorkItem.Events.Updated, {
      traceId: "trace-session-completed-fixture",
      time: completedAt,
      sessionId: completed.sessionId,
      payload: { hash: input.hash, fields: ["completionTerminalReceipt"] },
    });
    Bus.publish(WorkItem.Events.CompletedV2, {
      traceId: "trace-session-completed-fixture",
      time: completedAt,
      sessionId: completed.sessionId,
      payload: { ...receipt, sessionId: completed.sessionId },
    });
  }
  return completed;
}
