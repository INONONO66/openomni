import { describe, expect, test } from "bun:test";
import { WorkItem } from "../../src/index.js";

const workItemId = "wi_terminal_linkage";
const statement = "publish the artifact";
const basisRef = "basis:terminal";
const contractRevision = "contract:terminal";
const evidenceId = "evidence:terminal";
const criterionId = WorkItem.criterionId(workItemId, 0, statement);
const completionReport = {
  summary: "Published the artifact.",
  claims: [{ statement, evidenceIds: [evidenceId] }],
  caveats: [],
  followUps: [],
};
const completionReportRef = WorkItem.completionReportReference(completionReport);
const observation = WorkItem.Observation.parse({
  id: "observation:terminal",
  producer: "verifier:terminal",
  subjectRef: workItemId,
  basisRef,
  artifactRefs: [evidenceId],
  ancestryRefs: [],
  observedAt: 6,
});
const claim = WorkItem.Claim.parse({
  id: "claim:terminal",
  criterionId,
  statement,
  observationIds: [observation.id],
  basisRef,
  createdAt: 6,
});
const result = WorkItem.CriterionResult.parse({
  id: "result:terminal",
  criterionId,
  observationIds: [observation.id],
  value: "asserted",
  assumptions: [],
  residualRisks: [],
  basisRef,
  createdAt: 6,
});
const admission = WorkItem.CompletionAdmission.parse({
  version: 1,
  id: "admission:terminal",
  requestId: "completion-request:terminal",
  workItemHash: workItemId,
  origin: "worker",
  contractRevision,
  basisRef,
  requestRoot: "request-root:terminal",
  proposedFactIds: {
    claims: [claim.id],
    observations: [observation.id],
    results: [result.id],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  },
  effectiveResultIds: [result.id],
  unresolvedCriterionIds: [],
  decision: "admit",
  reasonCodes: [],
  residualRisks: [],
  policyRef: "policy:terminal",
  completionReportSnapshot: completionReport,
  completionReportRef,
  expectedHead: 0,
  recordedHead: 1,
  createdAt: 7,
});

function terminalItem(evidence: { readonly attempt: number; readonly passed: boolean }) {
  return WorkItem.Info.parse({
    workItemId,
    revision: 2,
    name: "Terminal linkage",
    sourceMessageId: "message:terminal",
    sourceChannel: "test",
    attempt: 2,
    timestamps: { created: 1, updated: 8, completed: 8 },
    relations: { childIds: [], dependsOn: [] },
    intent: "complete",
    goal: statement,
    blockers: [],
    evidence: [
      {
        id: evidenceId,
        kind: "verification",
        description: "Publication verification",
        basisRef,
        createdAt: 6,
        ...evidence,
      },
    ],
    constraints: [],
    acceptanceCriteria: [statement],
    changedFiles: [],
    completionContract: { version: 1, revision: contractRevision, basisRef },
    completionFacts: {
      ...WorkItem.emptyCompletionFacts(),
      revision: 1,
      criteria: [{ id: criterionId, revision: 1, statement, required: true }],
      claims: [claim],
      observations: [observation],
      results: [result],
      admissions: [admission],
    },
    completionReport,
    completionTerminalReceipt: {
      version: 1,
      hash: workItemId,
      requestId: admission.requestId,
      admissionId: admission.id,
      contractRevision,
      basisRef,
      completionReportRef,
      recordedHead: 2,
    },
  });
}

describe("completion terminal evidence linkage", () => {
  test("rejects evidence produced by a prior attempt", () => {
    const current = WorkItem.validateCompletionTerminalLinkage(
      terminalItem({ attempt: 2, passed: true }),
    );
    const stale = WorkItem.validateCompletionTerminalLinkage(
      terminalItem({ attempt: 1, passed: true }),
    );

    expect(current.success).toBe(true);
    expect(stale.success).toBe(false);
  });

  test("rejects evidence whose verification failed", () => {
    const passed = WorkItem.validateCompletionTerminalLinkage(
      terminalItem({ attempt: 2, passed: true }),
    );
    const failed = WorkItem.validateCompletionTerminalLinkage(
      terminalItem({ attempt: 2, passed: false }),
    );

    expect(passed.success).toBe(true);
    expect(failed.success).toBe(false);
  });
});
