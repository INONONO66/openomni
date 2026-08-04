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
        id: "evidence:legacy-driver-fail",
        kind: "verification",
        description: "Legacy evidence recorded a failure",
        passed: false,
        createdAt: 7,
      },
    ],
    completionReport: {
      summary: "Historical completion report",
      claims: [
        { statement: "Passed legacy claim", evidenceIds: ["evidence:legacy-driver-pass"] },
        { statement: "Failed legacy claim", evidenceIds: ["evidence:legacy-driver-fail"] },
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
  const failedEvidencePreserved =
    first.evidence.some(({ id, passed }) => id === "evidence:legacy-driver-fail" && !passed) &&
    first.completionFacts.results.some(({ value, observationIds }) => {
      if (value !== "refuted") return false;
      return observationIds.some((observationId) =>
        first.completionFacts.observations.some(
          ({ id, artifactRefs }) =>
            id === observationId && artifactRefs.includes("evidence:legacy-driver-fail"),
        ),
      );
    });
  const resultValues = first.completionFacts.results.map(({ value }) => value);
  const verifiedResultCount = resultValues.filter((value) => value === "verified").length;
  const ok =
    sourceUnchanged &&
    stableCriterionIds &&
    stableAdmissionIds &&
    stableReceiptIds &&
    allClaimsPreserved &&
    failedEvidencePreserved &&
    resultValues.includes("asserted") &&
    resultValues.includes("refuted") &&
    verifiedResultCount === 0;

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
      claimCount: first.completionFacts.claims.length,
      failedEvidencePreserved,
      resultValues,
      verifiedResultCount,
      archivedStatus: WorkItem.deriveStatus(first),
    },
  );
}
