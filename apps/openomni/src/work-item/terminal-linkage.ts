import { WorkItem } from "@openomni/protocol";
import { z, type RefinementCtx } from "zod";

type TerminalLinkageItem = WorkItem.Info;
type CompletionAdmission = WorkItem.CompletionAdmission;
type CompletionReport = WorkItem.CompletionReport;

/**
 * Product completion authority. Protocol parsing deliberately accepts the
 * terminal fields as wire shape; only this app-owned admission validator may
 * approve their linkage and completion semantics.
 */
function validateTerminalLinkage(item: TerminalLinkageItem, ctx: RefinementCtx): void {
  const evidenceIds = new Set<string>();
  for (const [index, evidence] of item.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) {
      addIssue(ctx, ["evidence", index, "id"]);
    }
    evidenceIds.add(evidence.id);
  }
  const foreignAdmissionIndex = item.completionFacts.admissions.findIndex(
    ({ workItemHash }) => workItemHash !== item.workItemId,
  );
  if (foreignAdmissionIndex !== -1) {
    addIssue(ctx, ["completionFacts", "admissions", foreignAdmissionIndex, "workItemHash"]);
  }
  const receipt = item.completionTerminalReceipt;
  const completedAt = item.timestamps.completed;
  if (completedAt !== undefined && receipt === undefined) {
    addIssue(ctx, ["completionTerminalReceipt"], "completed WorkItem requires receipt");
    return;
  }
  if (receipt === undefined) return;
  if (completedAt === undefined) {
    addIssue(ctx, ["timestamps", "completed"], "receipt requires completed timestamp");
  }
  if (receipt.hash !== item.workItemId) addIssue(ctx, ["completionTerminalReceipt", "hash"]);
  if (receipt.contractRevision !== item.completionContract.revision) {
    addIssue(ctx, ["completionTerminalReceipt", "contractRevision"]);
  }
  if (receipt.basisRef !== item.completionContract.basisRef) {
    addIssue(ctx, ["completionTerminalReceipt", "basisRef"]);
  }
  if (receipt.recordedHead > item.revision) {
    addIssue(ctx, ["completionTerminalReceipt", "recordedHead"]);
  }

  const admissionIndex = item.completionFacts.admissions.findIndex(
    ({ id }) => id === receipt.admissionId,
  );
  if (admissionIndex === -1) {
    addIssue(ctx, ["completionTerminalReceipt", "admissionId"]);
    return;
  }
  const admission = item.completionFacts.admissions[admissionIndex];
  if (admission === undefined) {
    addIssue(ctx, ["completionTerminalReceipt", "admissionId"]);
    return;
  }
  validateProposedFactIds(item, admission, admissionIndex, ctx);
  if (admission.decision !== "admit") {
    addIssue(ctx, ["completionFacts", "admissions", admissionIndex, "decision"]);
  }
  const criteriaById = new Map(
    item.completionFacts.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const resultsById = new Map(
    item.completionFacts.results.map((result, index) => [result.id, { index, result }]),
  );
  const observationsById = new Map(
    item.completionFacts.observations.map((observation, index) => [
      observation.id,
      { index, observation },
    ]),
  );
  const effectiveCriterionIds = new Set<string>();
  for (const [index, criterionId] of admission.unresolvedCriterionIds.entries()) {
    if (!criteriaById.has(criterionId)) {
      addIssue(
        ctx,
        ["completionFacts", "admissions", admissionIndex, "unresolvedCriterionIds", index],
        "terminal admission references an unknown unresolved criterion",
      );
    }
  }
  for (const [index, resultId] of admission.effectiveResultIds.entries()) {
    const effective = resultsById.get(resultId);
    if (!effective) {
      addIssue(
        ctx,
        ["completionFacts", "admissions", admissionIndex, "effectiveResultIds", index],
        "terminal admission references a missing effective result",
      );
      continue;
    }
    const { result } = effective;
    if (!criteriaById.has(result.criterionId)) {
      addIssue(
        ctx,
        ["completionFacts", "results", effective.index, "criterionId"],
        "terminal admission effective result references an unknown criterion",
      );
    }
    if (result.basisRef !== admission.basisRef) {
      addIssue(
        ctx,
        ["completionFacts", "results", effective.index, "basisRef"],
        "terminal admission effective result uses a different basis",
      );
    }
    for (const [observationIndex, observationId] of result.observationIds.entries()) {
      const resolved = observationsById.get(observationId);
      if (!resolved) {
        addIssue(ctx, [
          "completionFacts",
          "results",
          effective.index,
          "observationIds",
          observationIndex,
        ]);
        continue;
      }
      if (resolved.observation.subjectRef !== item.workItemId) {
        addIssue(ctx, ["completionFacts", "observations", resolved.index, "subjectRef"]);
      }
      if (resolved.observation.basisRef !== result.basisRef) {
        addIssue(ctx, ["completionFacts", "observations", resolved.index, "basisRef"]);
      }
    }
    if (result.value !== "verified") {
      addIssue(
        ctx,
        ["completionFacts", "results", effective.index, "value"],
        "terminal admission effective result is not admissible",
      );
    }
    effectiveCriterionIds.add(result.criterionId);
  }
  for (const [index, criterion] of item.completionFacts.criteria.entries()) {
    if (criterion.required && !effectiveCriterionIds.has(criterion.id)) {
      addIssue(
        ctx,
        ["completionFacts", "criteria", index, "id"],
        "terminal admission does not cover a required criterion",
      );
    }
  }
  const proposedResultIds = new Set(admission.proposedFactIds.results);
  for (const { index, result } of resultsById.values()) {
    if (proposedResultIds.has(result.id) && result.value !== "verified") {
      addIssue(
        ctx,
        ["completionFacts", "results", index, "value"],
        "terminal admission proposed result is not verified",
      );
    }
  }
  if (admission.requestId !== receipt.requestId) {
    addIssue(ctx, ["completionTerminalReceipt", "requestId"]);
  }
  if (
    item.completionReport === undefined ||
    admission.completionReportSnapshot === undefined ||
    admission.completionReportRef === undefined ||
    receipt.completionReportRef === undefined
  ) {
    addIssue(
      ctx,
      ["completionTerminalReceipt", "completionReportRef"],
      "terminal receipt requires canonical completion report linkage",
    );
    return;
  }
  if (
    admission.completionReportRef !== receipt.completionReportRef ||
    admission.completionReportRef !==
      WorkItem.completionReportReference(admission.completionReportSnapshot) ||
    JSON.stringify(admission.completionReportSnapshot) !== JSON.stringify(item.completionReport)
  ) {
    addIssue(ctx, ["completionTerminalReceipt", "completionReportRef"]);
  }
  validateCompletionReportEvidence(
    item,
    admission,
    item.completionReport,
    effectiveCriterionIds,
    ctx,
  );
  const hasReservationBridge = WorkItem.hasContiguousReservationBridge(
    item.completionFacts.requestReservations,
    admission.requestId,
    admission.recordedHead,
    receipt.recordedHead,
  );
  if (
    admission.contractRevision !== receipt.contractRevision ||
    admission.basisRef !== receipt.basisRef ||
    (admission.recordedHead + 1 !== receipt.recordedHead && !hasReservationBridge)
  ) {
    addIssue(ctx, ["completionFacts", "admissions", admissionIndex]);
  }
}

function validateProposedFactIds(
  item: TerminalLinkageItem,
  admission: CompletionAdmission,
  admissionIndex: number,
  ctx: RefinementCtx,
): void {
  const collections = [
    ["claims", item.completionFacts.claims, admission.proposedFactIds.claims],
    ["observations", item.completionFacts.observations, admission.proposedFactIds.observations],
    ["results", item.completionFacts.results, admission.proposedFactIds.results],
    ["invalidations", item.completionFacts.invalidations, admission.proposedFactIds.invalidations],
    [
      "verificationErrors",
      item.completionFacts.verificationErrors,
      admission.proposedFactIds.verificationErrors,
    ],
    ["effects", item.completionFacts.effects, admission.proposedFactIds.effects],
  ] as const;
  for (const [collection, durableFacts, proposedIds] of collections) {
    const durableIds = new Set(durableFacts.map(({ id }) => id));
    for (const [index, id] of proposedIds.entries()) {
      if (!durableIds.has(id)) {
        addIssue(ctx, [
          "completionFacts",
          "admissions",
          admissionIndex,
          "proposedFactIds",
          collection,
          index,
        ]);
      }
    }
  }
}

function validateCompletionReportEvidence(
  item: TerminalLinkageItem,
  admission: CompletionAdmission,
  report: CompletionReport,
  effectiveCriterionIds: ReadonlySet<string>,
  ctx: RefinementCtx,
): void {
  const evidenceById = new Map(item.evidence.map((evidence) => [evidence.id, evidence]));
  const observationsById = new Map(
    item.completionFacts.observations.map((observation, index) => [
      observation.id,
      { index, observation },
    ]),
  );
  const effectiveResultIdSet = new Set(admission.effectiveResultIds);
  const effectiveResults = item.completionFacts.results.filter((result) =>
    effectiveResultIdSet.has(result.id),
  );
  const criteriaById = new Map(
    item.completionFacts.criteria.map((criterion) => [criterion.id, criterion]),
  );
  for (const [claimIndex, claim] of item.completionFacts.claims.entries()) {
    const criterion = criteriaById.get(claim.criterionId);
    if (!criterion) {
      addIssue(ctx, ["completionFacts", "claims", claimIndex, "criterionId"]);
    } else if (criterion.statement !== claim.statement) {
      addIssue(ctx, ["completionFacts", "claims", claimIndex, "statement"]);
    }
  }
  for (const [claimIndex, reportClaim] of report.claims.entries()) {
    const admittedClaims = item.completionFacts.claims
      .map((claim, index) => ({ claim, index }))
      .filter(
        ({ claim }) =>
          claim.statement === reportClaim.statement &&
          claim.basisRef === admission.basisRef &&
          criteriaById.get(claim.criterionId)?.statement === claim.statement &&
          effectiveCriterionIds.has(claim.criterionId),
      );
    if (admittedClaims.length === 0) {
      addIssue(ctx, ["completionReport", "claims", claimIndex, "statement"]);
      continue;
    }
    const criterionIds = new Set(admittedClaims.map(({ claim }) => claim.criterionId));
    const effectiveObservationIds = new Set(
      effectiveResults
        .filter(({ criterionId }) => criterionIds.has(criterionId))
        .flatMap(({ observationIds }) => observationIds),
    );
    const admittedEvidenceIds = new Set(
      admittedClaims.flatMap(({ claim, index: durableClaimIndex }) =>
        claim.observationIds.flatMap((observationId, observationIndex) => {
          const resolved = observationsById.get(observationId);
          if (!resolved) {
            addIssue(ctx, [
              "completionFacts",
              "claims",
              durableClaimIndex,
              "observationIds",
              observationIndex,
            ]);
            return [];
          }
          if (!effectiveObservationIds.has(observationId)) {
            return [];
          }
          const { index, observation } = resolved;
          if (observation.subjectRef !== item.workItemId) {
            addIssue(ctx, ["completionFacts", "observations", index, "subjectRef"]);
            return [];
          }
          if (observation.basisRef !== admission.basisRef) {
            addIssue(ctx, ["completionFacts", "observations", index, "basisRef"]);
            return [];
          }
          return [
            ...observation.artifactRefs,
            ...(observation.provenanceRef === undefined ? [] : [observation.provenanceRef]),
          ];
        }),
      ),
    );
    for (const [evidenceIndex, evidenceId] of reportClaim.evidenceIds.entries()) {
      const evidence = evidenceById.get(evidenceId);
      if (
        evidence === undefined ||
        evidence.attempt !== item.attempt ||
        evidence.basisRef !== admission.basisRef ||
        !evidence.passed ||
        evidence.readBack?.passed === false ||
        !admittedEvidenceIds.has(evidenceId)
      ) {
        addIssue(ctx, ["completionReport", "claims", claimIndex, "evidenceIds", evidenceIndex]);
      }
    }
  }
}

function addIssue(
  ctx: RefinementCtx,
  path: (string | number)[],
  message = "terminal linkage mismatch",
): void {
  ctx.addIssue({ code: "custom", path, message });
}

const CompletionTerminalLinkage = z.custom<WorkItem.Info>().superRefine(validateTerminalLinkage);

export function validateCompletionTerminalLinkage(item: WorkItem.Info) {
  return CompletionTerminalLinkage.safeParse(item);
}
