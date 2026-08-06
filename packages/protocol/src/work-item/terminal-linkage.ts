import type { RefinementCtx } from "zod";
import {
  completionReportReference,
  type CompletionAdmission,
  type CompletionContract,
  type CompletionReport,
  type CompletionRequestReservation,
  type CompletionTerminalReceipt,
  type Claim,
  type Criterion,
  type CriterionResult,
  type Observation,
} from "./completion-admission.js";

type TerminalLinkageItem = Readonly<{
  hash: string;
  revision: number;
  attempt: number;
  timestamps: Readonly<{ completed?: number }>;
  evidence: readonly Readonly<{
    id: string;
    passed: boolean;
    attempt?: number;
    basisRef?: string;
    readBack?: Readonly<{ passed: boolean }>;
  }>[];
  completionContract: CompletionContract;
  completionFacts: Readonly<{
    criteria: readonly Criterion[];
    claims: readonly Claim[];
    observations: readonly Observation[];
    results: readonly CriterionResult[];
    admissions: readonly CompletionAdmission[];
    requestReservations?: readonly CompletionRequestReservation[];
  }>;
  completionReport?: CompletionReport;
  completionTerminalReceipt?: CompletionTerminalReceipt;
}>;

export function validateTerminalLinkage(item: TerminalLinkageItem, ctx: RefinementCtx): void {
  const evidenceIds = new Set<string>();
  for (const [index, evidence] of item.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) {
      addIssue(ctx, ["evidence", index, "id"]);
    }
    evidenceIds.add(evidence.id);
  }
  const foreignAdmissionIndex = item.completionFacts.admissions.findIndex(
    ({ requestSnapshot }) => requestSnapshot.workItemHash !== item.hash,
  );
  if (foreignAdmissionIndex !== -1) {
    addIssue(ctx, [
      "completionFacts",
      "admissions",
      foreignAdmissionIndex,
      "requestSnapshot",
      "workItemHash",
    ]);
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
  if (receipt.hash !== item.hash) addIssue(ctx, ["completionTerminalReceipt", "hash"]);
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
  if (admission.decision !== "admit" && admission.decision !== "owner_override") {
    addIssue(ctx, ["completionFacts", "admissions", admissionIndex, "decision"]);
  }
  if (admission.decision === "admit" && admission.unresolvedCriterionIds.length > 0) {
    addIssue(
      ctx,
      ["completionFacts", "admissions", admissionIndex, "unresolvedCriterionIds"],
      "terminal admit cannot carry unresolved required criteria",
    );
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
      if (resolved.observation.subjectRef !== item.hash) {
        addIssue(ctx, ["completionFacts", "observations", resolved.index, "subjectRef"]);
      }
      if (resolved.observation.basisRef !== result.basisRef) {
        addIssue(ctx, ["completionFacts", "observations", resolved.index, "basisRef"]);
      }
    }
    if (
      admission.decision === "admit" &&
      result.value !== "asserted" &&
      result.value !== "verified"
    ) {
      addIssue(
        ctx,
        ["completionFacts", "results", effective.index, "value"],
        "terminal admission effective result is not admissible",
      );
    }
    effectiveCriterionIds.add(result.criterionId);
  }
  for (const [index, criterion] of item.completionFacts.criteria.entries()) {
    if (
      admission.decision === "admit" &&
      criterion.required &&
      !effectiveCriterionIds.has(criterion.id)
    ) {
      addIssue(
        ctx,
        ["completionFacts", "criteria", index, "id"],
        "terminal admission does not cover a required criterion",
      );
    }
  }
  if (
    admission.decision === "owner_override" &&
    (!admission.ownerOverrideReceiptRef ||
      admission.ownerOverrideReceiptRef !== admission.requestSnapshot.ownerOverrideReceiptRef)
  ) {
    addIssue(
      ctx,
      ["completionFacts", "admissions", admissionIndex, "ownerOverrideReceiptRef"],
      "terminal owner_override requires its request-bound receipt",
    );
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
      completionReportReference(admission.completionReportSnapshot) ||
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
  const reservationBridges = (item.completionFacts.requestReservations ?? []).filter(
    (reservation) =>
      reservation.requestId === admission.requestId &&
      reservation.recordedHead > admission.recordedHead &&
      reservation.recordedHead < receipt.recordedHead,
  );
  const expectedBridgeCount = receipt.recordedHead - admission.recordedHead - 1;
  const reservationBridgeHeads = new Set(
    reservationBridges.map(({ recordedHead }) => recordedHead),
  );
  const hasReservationBridge =
    expectedBridgeCount > 0 &&
    reservationBridges.length === expectedBridgeCount &&
    reservationBridgeHeads.size === expectedBridgeCount &&
    Array.from(
      { length: expectedBridgeCount },
      (_, index) => admission.recordedHead + index + 1,
    ).every((head) => reservationBridgeHeads.has(head));
  if (
    admission.contractRevision !== receipt.contractRevision ||
    admission.basisRef !== receipt.basisRef ||
    (admission.recordedHead + 1 !== receipt.recordedHead && !hasReservationBridge)
  ) {
    addIssue(ctx, ["completionFacts", "admissions", admissionIndex]);
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
  const effectiveResults = item.completionFacts.results.filter((result) =>
    admission.effectiveResultIds.includes(result.id),
  );
  for (const [claimIndex, reportClaim] of report.claims.entries()) {
    const admittedClaims = item.completionFacts.claims
      .map((claim, index) => ({ claim, index }))
      .filter(
        ({ claim }) =>
          claim.statement === reportClaim.statement &&
          claim.basisRef === admission.basisRef &&
          (admission.decision === "owner_override" || effectiveCriterionIds.has(claim.criterionId)),
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
          if (
            admission.decision !== "owner_override" &&
            !effectiveObservationIds.has(observationId)
          ) {
            return [];
          }
          const { index, observation } = resolved;
          if (observation.subjectRef !== item.hash) {
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
