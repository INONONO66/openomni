import type { RefinementCtx } from "zod";
import {
  completionReportReference,
  type CompletionAdmission,
  type CompletionContract,
  type CompletionReport,
  type CompletionTerminalReceipt,
  type Criterion,
  type CriterionResult,
} from "./completion-admission.js";

type TerminalLinkageItem = Readonly<{
  hash: string;
  revision: number;
  timestamps: Readonly<{ completed?: number }>;
  completionContract: CompletionContract;
  completionFacts: Readonly<{
    criteria: readonly Criterion[];
    results: readonly CriterionResult[];
    admissions: readonly CompletionAdmission[];
  }>;
  completionReport?: CompletionReport;
  completionTerminalReceipt?: CompletionTerminalReceipt;
}>;

export function validateTerminalLinkage(item: TerminalLinkageItem, ctx: RefinementCtx): void {
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

  const admission = item.completionFacts.admissions.find(({ id }) => id === receipt.admissionId);
  if (!admission) {
    addIssue(ctx, ["completionTerminalReceipt", "admissionId"]);
    return;
  }
  if (admission.decision !== "admit" && admission.decision !== "owner_override") {
    addIssue(ctx, ["completionFacts", "admissions"]);
  }
  if (admission.decision === "admit" && admission.unresolvedCriterionIds.length > 0) {
    addIssue(
      ctx,
      ["completionFacts", "admissions", "unresolvedCriterionIds"],
      "terminal admit cannot carry unresolved required criteria",
    );
  }
  const criteriaById = new Map(
    item.completionFacts.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const resultsById = new Map(
    item.completionFacts.results.map((result, index) => [result.id, { index, result }]),
  );
  const effectiveCriterionIds = new Set<string>();
  for (const [index, criterionId] of admission.unresolvedCriterionIds.entries()) {
    if (!criteriaById.has(criterionId)) {
      addIssue(
        ctx,
        ["completionFacts", "admissions", "unresolvedCriterionIds", index],
        "terminal admission references an unknown unresolved criterion",
      );
    }
  }
  for (const [index, resultId] of admission.effectiveResultIds.entries()) {
    const effective = resultsById.get(resultId);
    if (!effective) {
      addIssue(
        ctx,
        ["completionFacts", "admissions", "effectiveResultIds", index],
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
    if (result.value !== "asserted" && result.value !== "verified") {
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
  if (
    admission.decision === "owner_override" &&
    (!admission.ownerOverrideReceiptRef ||
      admission.ownerOverrideReceiptRef !== admission.requestSnapshot.ownerOverrideReceiptRef)
  ) {
    addIssue(
      ctx,
      ["completionFacts", "admissions", "ownerOverrideReceiptRef"],
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
  if (
    admission.contractRevision !== receipt.contractRevision ||
    admission.basisRef !== receipt.basisRef ||
    admission.recordedHead + 1 !== receipt.recordedHead
  ) {
    addIssue(ctx, ["completionFacts", "admissions"]);
  }
}

function addIssue(
  ctx: RefinementCtx,
  path: (string | number)[],
  message = "terminal linkage mismatch",
): void {
  ctx.addIssue({ code: "custom", path, message });
}
