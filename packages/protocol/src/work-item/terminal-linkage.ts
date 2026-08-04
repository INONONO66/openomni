import type { RefinementCtx } from "zod";
import type {
  CompletionAdmission,
  CompletionContract,
  CompletionTerminalReceipt,
} from "./completion-admission.js";

type TerminalLinkageItem = Readonly<{
  hash: string;
  revision: number;
  timestamps: Readonly<{ completed?: number }>;
  completionContract: CompletionContract;
  completionFacts: Readonly<{ admissions: readonly CompletionAdmission[] }>;
  completionTerminalReceipt?: CompletionTerminalReceipt;
}>;

export function validateTerminalLinkage(item: TerminalLinkageItem, ctx: RefinementCtx): void {
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
