import { createDefaultDispatchRuntime } from "@openomni/openomni";
import { PolicyEngine } from "@openomni/policy";
import type { WorkItem } from "@openomni/protocol";
import { type Storage, WorkItemStore } from "@openomni/ledger";
import { createCompletionAdmissionService } from "../../../packages/openomni/src/work-item/completion-admission";

export async function completeWorkItem(
  completionWriter: Storage.WorkItemCompletionWriter,
  hash: string,
): Promise<WorkItem.Info> {
  const withEvidence = await WorkItemStore.addEvidence(
    hash,
    {
      kind: "verification",
      description: "server test completion evidence",
      passed: true,
    },
    "trace-test",
  );
  const current = WorkItemStore.get(hash);
  const criterion = current?.completionFacts.criteria[0];
  const evidenceId = withEvidence?.evidence.at(-1)?.id;
  if (!current || !criterion || !evidenceId) throw new Error("expected completion fixture");

  const observationId = `observation:${hash}:${current.revision}:server-test`;
  const createdAt = current.timestamps.updated + 1;
  const result = await createDefaultDispatchRuntime({
    completionAdmissionService: createCompletionAdmissionService({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => createdAt + 1,
    }),
  }).submitActorWorkItemCompletion({
    source: { source: "resident", identity: { kind: "resident", id: "resident:server-test" } },
    traceId: "trace-test",
    request: {
      version: 1,
      id: `completion-request:${hash}:${current.revision}:server-test`,
      workItemHash: hash,
      contractRevision: current.completionContract.revision,
      basisRef: current.completionContract.basisRef,
      expectedHead: current.revision,
      claims: [
        {
          id: `claim:${hash}:${current.revision}:server-test`,
          criterionId: criterion.id,
          statement: criterion.statement,
          observationIds: [observationId],
          basisRef: current.completionContract.basisRef,
          createdAt,
        },
      ],
      observations: [
        {
          id: observationId,
          producer: "verifier:server-test",
          subjectRef: current.workItemId,
          basisRef: current.completionContract.basisRef,
          artifactRefs: [evidenceId],
          provenanceRef: evidenceId,
          ancestryRefs: [],
          observedAt: createdAt,
        },
      ],
      results: [
        {
          id: `result:${hash}:${current.revision}:server-test`,
          criterionId: criterion.id,
          value: "verified",
          checkedPredicate: criterion.statement,
          observationIds: [observationId],
          verifierRef: "verifier:server-test",
          assumptions: [],
          basisRef: current.completionContract.basisRef,
          residualRisks: [],
          createdAt,
        },
      ],
      invalidations: [],
      verificationErrors: [],
      effects: [],
    },
    completionReport: {
      summary: "Completed with server test evidence.",
      claims: [{ statement: criterion.statement, evidenceIds: [evidenceId] }],
      caveats: [],
      followUps: [],
    },
  });
  return result.workItem;
}
