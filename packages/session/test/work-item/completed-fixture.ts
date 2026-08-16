import { WorkItem } from "@openomni/protocol";
import { Storage } from "../../src";
import { Bus } from "@openomni/telemetry";

export function completedFixtureResults(
  item: WorkItem.Info,
  source: string,
): WorkItem.CriterionResult[] {
  return item.completionFacts.criteria
    .filter(({ required }) => required)
    .map((criterion, index) =>
      WorkItem.CriterionResult.parse({
        id: `result:${item.hash}:${source}:${index}`,
        criterionId: criterion.id,
        observationIds: [],
        value: "asserted",
        assumptions: [],
        residualRisks: [],
        basisRef: item.completionContract.basisRef,
        createdAt: item.timestamps.updated + 1,
      }),
    );
}

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
  const matchedCriterionIds = new Set<string>();
  const evidenceIds = new Set(current.evidence.map(({ id }) => id));
  const evidenceAdditions: WorkItem.Evidence[] = [];
  const observations: WorkItem.Observation[] = [];
  const claims: WorkItem.Claim[] = [];
  const results: WorkItem.CriterionResult[] = [];
  completionReport.claims.forEach((reportClaim, claimIndex) => {
    const criterion = current.completionFacts.criteria.find(
      (candidate) =>
        !matchedCriterionIds.has(candidate.id) && candidate.statement === reportClaim.statement,
    );
    if (!criterion) {
      throw new Error(`completed fixture report claim has no criterion: ${reportClaim.statement}`);
    }
    matchedCriterionIds.add(criterion.id);
    const claimObservationIds = reportClaim.evidenceIds.map((evidenceId, evidenceIndex) => {
      if (!evidenceIds.has(evidenceId)) {
        evidenceIds.add(evidenceId);
        evidenceAdditions.push({
          id: evidenceId,
          kind: "verification",
          description: `Completed fixture evidence for ${reportClaim.statement}`,
          passed: true,
          attempt: current.attempt,
          basisRef: current.completionContract.basisRef,
          createdAt: current.timestamps.updated + 1,
        });
      }
      const observation = WorkItem.Observation.parse({
        id: `observation:${current.hash}:session-fixture:${claimIndex}:${evidenceIndex}`,
        producer: "session-completed-fixture",
        subjectRef: current.hash,
        basisRef: current.completionContract.basisRef,
        artifactRefs: [evidenceId],
        provenanceRef: evidenceId,
        ancestryRefs: [],
        observedAt: current.timestamps.updated + 1,
      });
      observations.push(observation);
      return observation.id;
    });
    const claim = WorkItem.Claim.parse({
      id: `claim:${current.hash}:session-fixture:${claimIndex}`,
      criterionId: criterion.id,
      statement: reportClaim.statement,
      observationIds: claimObservationIds,
      basisRef: current.completionContract.basisRef,
      createdAt: current.timestamps.updated + 1,
    });
    claims.push(claim);
    results.push(
      WorkItem.CriterionResult.parse({
        id: `result:${current.hash}:session-fixture:${claimIndex}`,
        criterionId: criterion.id,
        observationIds: claimObservationIds,
        value: "asserted",
        assumptions: [],
        residualRisks: [],
        basisRef: current.completionContract.basisRef,
        createdAt: current.timestamps.updated + 1,
      }),
    );
  });
  const resolvedCriterionIds = new Set(results.map(({ criterionId }) => criterionId));
  const unresolvedRequiredCriterion = current.completionFacts.criteria.find(
    ({ id, required }) => required && !resolvedCriterionIds.has(id),
  );
  if (unresolvedRequiredCriterion) {
    throw new Error(
      `completed fixture report omits required criterion: ${unresolvedRequiredCriterion.statement}`,
    );
  }
  const completionReportRef = WorkItem.completionReportReference(completionReport);
  const requestId = `completion-request:${input.hash}:${current.revision}:session-fixture`;
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${input.hash}:${current.revision + 1}:session-fixture`,
    requestId,
    workItemHash: input.hash,
    origin: "recovery",
    contractRevision: current.completionContract.revision,
    basisRef: current.completionContract.basisRef,
    requestRoot: "request-root:fixture",
    proposedFactIds: {
      claims: claims.map(({ id }) => id),
      observations: observations.map(({ id }) => id),
      results: results.map(({ id }) => id),
      invalidations: [],
      verificationErrors: [],
      effects: [],
    },
    effectiveResultIds: results.map(({ id }) => id),
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
    evidence: [...current.evidence, ...evidenceAdditions],
    completionFacts: {
      ...current.completionFacts,
      revision: current.completionFacts.revision + 1,
      claims: [...current.completionFacts.claims, ...claims],
      observations: [...current.completionFacts.observations, ...observations],
      results: [...current.completionFacts.results, ...results],
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
