import { WorkItem } from "@openomni/protocol";
import { completionAdmissionScenarioReceipt } from "./completion-admission-driver-contract.js";

export function runLegacyArchiveCompletionAdmissionScenario() {
  const legacy = {
    hash: "wi_driver_legacy_archive",
    name: "Archived completion",
    sourceMessageId: "message:legacy-driver",
    sourceChannel: "archive",
    attempt: 1,
    timestamps: { created: 1, updated: 8, completed: 8 },
    relations: { childHashes: [], dependsOn: [] },
    intent: "archive",
    goal: "Preserve the historical completion",
    constraints: [],
    acceptanceCriteria: ["Passed legacy claim", "Failed legacy claim"],
    changedFiles: [],
    blockers: [],
    evidence: [
      {
        id: "evidence:legacy-driver-pass",
        kind: "verification",
        description: "Legacy claimant marked this evidence passed",
        passed: true,
        createdAt: 6,
      },
      {
        id: "evidence:legacy-driver-second-pass",
        kind: "verification",
        description: "Legacy claimant marked the second evidence passed",
        passed: true,
        createdAt: 7,
      },
      {
        id: "evidence:legacy-driver-fail",
        kind: "verification",
        description: "Unrelated legacy evidence recorded a failure",
        passed: false,
        createdAt: 8,
      },
    ],
    completionReport: {
      summary: "Historical completion report",
      claims: [
        { statement: "Passed legacy claim", evidenceIds: ["evidence:legacy-driver-pass"] },
        {
          statement: "Failed legacy claim",
          evidenceIds: ["evidence:legacy-driver-second-pass"],
        },
      ],
      caveats: ["Archived without retrospective verification"],
      followUps: [],
    },
  };
  const sourceBefore = JSON.stringify(legacy);
  const first = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacy));
  const second = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacy));
  const sourceUnchanged = JSON.stringify(legacy) === sourceBefore;
  const stableCriterionIds =
    JSON.stringify(first.completionFacts.criteria.map(({ id }) => id)) ===
    JSON.stringify(second.completionFacts.criteria.map(({ id }) => id));
  const stableAdmissionIds =
    JSON.stringify(first.completionFacts.admissions.map(({ id }) => id)) ===
    JSON.stringify(second.completionFacts.admissions.map(({ id }) => id));
  const stableReceiptIds =
    first.completionTerminalReceipt?.admissionId ===
      second.completionTerminalReceipt?.admissionId &&
    first.completionTerminalReceipt?.requestId === second.completionTerminalReceipt?.requestId;
  const allClaimsPreserved =
    first.completionFacts.claims.length === legacy.completionReport.claims.length &&
    legacy.completionReport.claims.every((claim) =>
      first.completionFacts.claims.some(({ statement }) => statement === claim.statement),
    );
  const observationsById = new Map(
    first.completionFacts.observations.map((observation) => [observation.id, observation]),
  );
  const claimEvidenceProvenancePreserved = legacy.completionReport.claims.every((legacyClaim) => {
    const claim = first.completionFacts.claims.find(
      ({ statement }) => statement === legacyClaim.statement,
    );
    if (!claim) return false;
    const artifactRefs = [
      ...new Set(
        claim.observationIds.flatMap(
          (observationId) => observationsById.get(observationId)?.artifactRefs ?? [],
        ),
      ),
    ].sort();
    return JSON.stringify(artifactRefs) === JSON.stringify([...legacyClaim.evidenceIds].sort());
  });
  const failedEvidencePreserved =
    first.evidence.some(({ id, passed }) => id === "evidence:legacy-driver-fail" && !passed) &&
    first.completionFacts.observations.some(({ artifactRefs }) =>
      artifactRefs.includes("evidence:legacy-driver-fail"),
    ) &&
    !first.completionFacts.results.some(({ observationIds }) =>
      observationIds.some((observationId) =>
        first.completionFacts.observations.some(
          ({ id, artifactRefs }) =>
            id === observationId && artifactRefs.includes("evidence:legacy-driver-fail"),
        ),
      ),
    );
  const resultValues = first.completionFacts.results.map(({ value }) => value);
  const verifiedResultCount = resultValues.filter((value) => value === "verified").length;
  const allRequiredCriteriaEvidenced = first.completionFacts.criteria
    .filter(({ required }) => required)
    .every((criterion) =>
      first.completionFacts.results.some(
        ({ criterionId, observationIds }) =>
          criterionId === criterion.id && observationIds.length > 0,
      ),
    );
  const archivedStatus = WorkItem.deriveStatus(first);
  const admissionCount = first.completionFacts.admissions.length;
  const terminalReceiptLinked =
    first.completionTerminalReceipt !== undefined &&
    first.completionFacts.admissions.some(
      ({ id }) => id === first.completionTerminalReceipt?.admissionId,
    );
  const ok =
    sourceUnchanged &&
    stableCriterionIds &&
    stableAdmissionIds &&
    stableReceiptIds &&
    allClaimsPreserved &&
    claimEvidenceProvenancePreserved &&
    failedEvidencePreserved &&
    resultValues.includes("asserted") &&
    verifiedResultCount === 0 &&
    allRequiredCriteriaEvidenced &&
    archivedStatus === "completed" &&
    admissionCount > 0 &&
    terminalReceiptLinked;

  return completionAdmissionScenarioReceipt(
    "legacy-archive",
    ok,
    "legacy_archive_upcast",
    "legacy_archive_upcast_failed",
    {
      sourceUnchanged,
      stableCriterionIds,
      stableAdmissionIds,
      stableReceiptIds,
      criterionIds: first.completionFacts.criteria.map(({ id }) => id),
      admissionIds: first.completionFacts.admissions.map(({ id }) => id),
      terminalReceipt: first.completionTerminalReceipt,
      allClaimsPreserved,
      claimEvidenceProvenancePreserved,
      claimCount: first.completionFacts.claims.length,
      failedEvidencePreserved,
      resultValues,
      verifiedResultCount,
      allRequiredCriteriaEvidenced,
      archivedStatus,
      admissionCount,
      terminalReceiptLinked,
    },
  );
}
