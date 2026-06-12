import { WorkItem } from "@openomni/protocol";

export function verifyCompletionReport(
  item: WorkItem.Info,
  completionReport: WorkItem.CompletionReport,
): WorkItem.CompletionReport {
  const report = WorkItem.CompletionReport.parse(completionReport);
  const evidenceIds = new Set(item.evidence.map((evidence) => evidence.id));
  const missing = report.claims.flatMap((claim) =>
    claim.evidenceIds.filter((evidenceId) => !evidenceIds.has(evidenceId)),
  );
  if (missing.length > 0) {
    throw new Error(`completion report references missing evidence: ${missing.join(", ")}`);
  }
  return report;
}
