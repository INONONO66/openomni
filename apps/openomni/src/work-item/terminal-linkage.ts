import { WorkItem } from "@openomni/protocol";
import { z } from "zod";

/**
 * Product completion authority. Protocol supplies pure durability linkage;
 * this app-owned judgment decides which linked terminal candidates may admit.
 */
const CompletionAuthority = z.custom<WorkItem.Info>().superRefine((item, ctx) => {
  const receipt = item.completionTerminalReceipt;
  if (receipt === undefined) return;
  const admissionIndex = item.completionFacts.admissions.findIndex(
    ({ id }) => id === receipt.admissionId,
  );
  const admission = item.completionFacts.admissions[admissionIndex];
  if (admission === undefined) return;
  if (admission.decision !== "admit") {
    ctx.addIssue({
      code: "custom",
      path: ["completionFacts", "admissions", admissionIndex, "decision"],
      message: "terminal completion requires an admitted app judgment",
    });
  }

  const resultsById = new Map(
    item.completionFacts.results.map((result, index) => [result.id, { index, result }]),
  );
  const effectiveCriterionIds = new Set<string>();
  for (const resultId of admission.effectiveResultIds) {
    const effective = resultsById.get(resultId);
    if (effective === undefined) continue;
    if (effective.result.value !== "verified") {
      ctx.addIssue({
        code: "custom",
        path: ["completionFacts", "results", effective.index, "value"],
        message: "terminal completion requires verified effective results",
      });
    }
    effectiveCriterionIds.add(effective.result.criterionId);
  }
  for (const [index, criterion] of item.completionFacts.criteria.entries()) {
    if (criterion.required && !effectiveCriterionIds.has(criterion.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["completionFacts", "criteria", index, "id"],
        message: "terminal completion requires verified coverage of every required criterion",
      });
    }
  }

  const proposedResultIds = new Set(admission.proposedFactIds.results);
  for (const { index, result } of resultsById.values()) {
    if (proposedResultIds.has(result.id) && result.value !== "verified") {
      ctx.addIssue({
        code: "custom",
        path: ["completionFacts", "results", index, "value"],
        message: "terminal completion may propose only verified results",
      });
    }
  }
});

export function validateCompletionTerminalLinkage(item: WorkItem.Info) {
  const linkage = WorkItem.validateCompletionTerminalLinkage(item);
  return linkage.success ? CompletionAuthority.safeParse(linkage.data) : linkage;
}
