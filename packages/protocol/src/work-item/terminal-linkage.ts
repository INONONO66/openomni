import { z, type RefinementCtx } from "zod";
import {
  completionReportReference,
  type CompletionAdmission,
  type CompletionReport,
} from "./completion-admission.js";
import type { Info as TerminalLinkageItem } from "./schemas.js";

/**
 * Pure terminal durability linkage. This validates cross-record references
 * without deciding which result values or admission decisions a product may
 * accept. Protocol schema parsing deliberately does not invoke this fold.
 */
function validateTerminalLinkage(item: TerminalLinkageItem, ctx: RefinementCtx): void {
  validateEvidenceIdentities(item, ctx);
  validateAdmissionOwnership(item, ctx);
  const receipt = item.completionTerminalReceipt;
  if (item.timestamps.completed !== undefined && receipt === undefined) {
    addIssue(ctx, ["completionTerminalReceipt"], "completed WorkItem requires receipt");
    return;
  }
  if (receipt === undefined) return;

  validateReceiptHeader(item, receipt, ctx);
  const admissionIndex = item.completionFacts.admissions.findIndex(
    ({ id }) => id === receipt.admissionId,
  );
  const admission = item.completionFacts.admissions[admissionIndex];
  if (admissionIndex === -1 || admission === undefined) {
    addIssue(ctx, ["completionTerminalReceipt", "admissionId"]);
    return;
  }

  validateProposedFactIds(item, admission, admissionIndex, ctx);
  const indexes = completionFactIndexes(item);
  validateUnresolvedCriteria(admission, admissionIndex, indexes.criteriaById, ctx);
  const effectiveCriterionIds = validateEffectiveResults(
    item,
    admission,
    admissionIndex,
    indexes,
    ctx,
  );
  if (admission.requestId !== receipt.requestId) {
    addIssue(ctx, ["completionTerminalReceipt", "requestId"]);
  }
  const report = validateCompletionReportLinkage(item, admission, receipt, ctx);
  if (report === undefined) return;
  validateCompletionReportEvidence(item, admission, report, effectiveCriterionIds, ctx);
  validateReceiptContinuity(item, admission, admissionIndex, receipt, ctx);
}

type TerminalReceipt = NonNullable<TerminalLinkageItem["completionTerminalReceipt"]>;
type CompletionCriterion = TerminalLinkageItem["completionFacts"]["criteria"][number];
type CompletionResult = TerminalLinkageItem["completionFacts"]["results"][number];
type CompletionObservation = TerminalLinkageItem["completionFacts"]["observations"][number];

interface CompletionFactIndexes {
  readonly criteriaById: ReadonlyMap<string, CompletionCriterion>;
  readonly resultsById: ReadonlyMap<
    string,
    { readonly index: number; readonly result: CompletionResult }
  >;
  readonly observationsById: ReadonlyMap<
    string,
    { readonly index: number; readonly observation: CompletionObservation }
  >;
}

function validateEvidenceIdentities(item: TerminalLinkageItem, ctx: RefinementCtx): void {
  const evidenceIds = new Set<string>();
  for (const [index, evidence] of item.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) addIssue(ctx, ["evidence", index, "id"]);
    evidenceIds.add(evidence.id);
  }
}

function validateAdmissionOwnership(item: TerminalLinkageItem, ctx: RefinementCtx): void {
  const index = item.completionFacts.admissions.findIndex(
    ({ workItemHash }) => workItemHash !== item.workItemId,
  );
  if (index !== -1) addIssue(ctx, ["completionFacts", "admissions", index, "workItemHash"]);
}

function validateReceiptHeader(
  item: TerminalLinkageItem,
  receipt: TerminalReceipt,
  ctx: RefinementCtx,
): void {
  if (item.timestamps.completed === undefined) {
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
}

function completionFactIndexes(item: TerminalLinkageItem): CompletionFactIndexes {
  return {
    criteriaById: new Map(
      item.completionFacts.criteria.map((criterion) => [criterion.id, criterion]),
    ),
    resultsById: new Map(
      item.completionFacts.results.map((result, index) => [result.id, { index, result }]),
    ),
    observationsById: new Map(
      item.completionFacts.observations.map((observation, index) => [
        observation.id,
        { index, observation },
      ]),
    ),
  };
}

function validateUnresolvedCriteria(
  admission: CompletionAdmission,
  admissionIndex: number,
  criteriaById: ReadonlyMap<string, CompletionCriterion>,
  ctx: RefinementCtx,
): void {
  for (const [index, criterionId] of admission.unresolvedCriterionIds.entries()) {
    if (!criteriaById.has(criterionId)) {
      addIssue(
        ctx,
        ["completionFacts", "admissions", admissionIndex, "unresolvedCriterionIds", index],
        "terminal admission references an unknown unresolved criterion",
      );
    }
  }
}

function validateEffectiveResults(
  item: TerminalLinkageItem,
  admission: CompletionAdmission,
  admissionIndex: number,
  indexes: CompletionFactIndexes,
  ctx: RefinementCtx,
): ReadonlySet<string> {
  const effectiveCriterionIds = new Set<string>();
  for (const [index, resultId] of admission.effectiveResultIds.entries()) {
    const effective = indexes.resultsById.get(resultId);
    if (effective === undefined) {
      addIssue(
        ctx,
        ["completionFacts", "admissions", admissionIndex, "effectiveResultIds", index],
        "terminal admission references a missing effective result",
      );
      continue;
    }
    validateEffectiveResult(item, admission, effective, indexes, ctx);
    effectiveCriterionIds.add(effective.result.criterionId);
  }
  return effectiveCriterionIds;
}

function validateEffectiveResult(
  item: TerminalLinkageItem,
  admission: CompletionAdmission,
  effective: { readonly index: number; readonly result: CompletionResult },
  indexes: CompletionFactIndexes,
  ctx: RefinementCtx,
): void {
  const { result } = effective;
  if (!indexes.criteriaById.has(result.criterionId)) {
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
    const resolved = indexes.observationsById.get(observationId);
    if (resolved === undefined) {
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
}

function validateCompletionReportLinkage(
  item: TerminalLinkageItem,
  admission: CompletionAdmission,
  receipt: TerminalReceipt,
  ctx: RefinementCtx,
): CompletionReport | undefined {
  const report = item.completionReport;
  if (
    report === undefined ||
    admission.completionReportSnapshot === undefined ||
    admission.completionReportRef === undefined ||
    receipt.completionReportRef === undefined
  ) {
    addIssue(
      ctx,
      ["completionTerminalReceipt", "completionReportRef"],
      "terminal receipt requires canonical completion report linkage",
    );
    return undefined;
  }
  if (
    admission.completionReportRef !== receipt.completionReportRef ||
    admission.completionReportRef !==
      completionReportReference(admission.completionReportSnapshot) ||
    JSON.stringify(admission.completionReportSnapshot) !== JSON.stringify(report)
  ) {
    addIssue(ctx, ["completionTerminalReceipt", "completionReportRef"]);
  }
  return report;
}

function validateReceiptContinuity(
  item: TerminalLinkageItem,
  admission: CompletionAdmission,
  admissionIndex: number,
  receipt: TerminalReceipt,
  ctx: RefinementCtx,
): void {
  const hasReservationBridge = hasContiguousReservationBridge(
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

const TerminalLinkage = z.custom<TerminalLinkageItem>().superRefine(validateTerminalLinkage);

export function validateCompletionTerminalLinkage(item: TerminalLinkageItem) {
  return TerminalLinkage.safeParse(item);
}

/** Pure structural fold for receipt heads separated by durable reservations. */
export function hasContiguousReservationBridge(
  reservations: readonly Readonly<{ requestId: string; recordedHead: number }>[],
  requestId: string,
  fromHead: number,
  toHead: number,
): boolean {
  const expected = toHead - fromHead - 1;
  if (expected <= 0) return false;
  const bridging = reservations.filter(
    (reservation) =>
      reservation.requestId === requestId &&
      reservation.recordedHead > fromHead &&
      reservation.recordedHead < toHead,
  );
  if (bridging.length !== expected) return false;
  const heads = new Set(bridging.map(({ recordedHead }) => recordedHead));
  if (heads.size !== expected) return false;
  for (let head = fromHead + 1; head < toHead; head += 1) {
    if (!heads.has(head)) return false;
  }
  return true;
}
