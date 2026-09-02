import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, Storage, WorkItemStore } from "@openomni/ledger";
import type { WorkItem } from "@openomni/protocol";
import { createWorkItemLinkage } from "../../src/delegation/work-item-linkage";
import { createCompletionPort } from "../../src/work-item/completion";

const CRITERIA = ["the widget builds green", "the widget report is written"] as const;

export type RecordedFixtureOptions = Readonly<{ value?: "verified" | "refuted" }>;
export type RecordedFixture = Readonly<{
  workItemId: string;
  item: WorkItem.Info;
  resultId: string;
  completion: ReturnType<typeof createCompletionPort>;
}>;

export function recordedCompletionSuite() {
  const directories: string[] = [];

  afterEach(() => {
    Storage.reset();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  return {
    async fixture(options: RecordedFixtureOptions = {}): Promise<RecordedFixture> {
      const directory = mkdtempSync(join(tmpdir(), "openomni-recorded-completion-"));
      directories.push(directory);
      const writer = initialize({ dbPath: join(directory, "ledger.db") });
      const workItemId = await createWorkItemLinkage({
        model: { provider: "fake", id: "fake-model" },
        now: () => Date.now(),
      }).openAssign({
        delegationId: "dg-recorded",
        workerRunId: "run-recorded",
        transport: "process",
        instruction: "assemble the widget",
        acceptanceCriteria: [...CRITERIA],
        sessionId: "sess-owner",
      });
      const item = WorkItemStore.get(workItemId);
      const criteria = item?.completionFacts.criteria ?? [];
      if (item === undefined || criteria.length === 0) {
        throw new Error("recorded fixture is incomplete");
      }
      const verifierRef = "verifier:command.v1:dg-recorded";
      const attemptId = item.currentAttemptId;
      if (attemptId === undefined) throw new Error("recorded fixture attempt identity missing");
      const observations = criteria.map((_criterion, index) => {
        const evidenceId = `evidence:verifier:dg-recorded:criterion-${index}`;
        return {
          id: `observation:verifier:dg-recorded:criterion-${index}`,
          producer: "verifier:command.v1",
          subjectRef: workItemId,
          basisRef: item.completionContract.basisRef,
          artifactRefs: [evidenceId],
          provenanceRef: evidenceId,
          ancestryRefs: [`attempt:${attemptId}`],
          observedAt: 1000,
        };
      });
      const results = criteria.map((criterion, index) => ({
        id: `result:verifier:dg-recorded:criterion-${index}`,
        criterionId: criterion.id,
        value: options.value ?? "verified",
        checkedPredicate: "command.v1:build:argv-digest:exit=0",
        observationIds: [observations[index]?.id ?? "missing"],
        verifierRef,
        assumptions: [],
        basisRef: item.completionContract.basisRef,
        residualRisks: [],
        createdAt: 1000,
      }));
      const recorded = WorkItemStore.appendVerificationFacts(
        workItemId,
        {
          expectedAttemptSeq: item.lastAttemptSeq,
          expectedAttemptId: attemptId,
          expectedBasisRef: item.completionContract.basisRef,
          observations,
          results,
          verificationErrors: [],
          evidence: criteria.map((criterion, index) => ({
            id: `evidence:verifier:dg-recorded:criterion-${index}`,
            kind: "verification",
            criterionId: criterion.id,
            description: "registered build verifier",
            passed: options.value !== "refuted",
            detail: "{}",
          })),
          verifierRef,
        },
        "trace-recorded",
      );
      if (recorded.kind !== "appended") {
        throw new Error(`recorded fixture refused: ${recorded.kind}`);
      }
      const current = WorkItemStore.get(workItemId);
      if (current === undefined) throw new Error("recorded fixture vanished");
      return {
        workItemId,
        item: current,
        resultId: results[0]?.id ?? "missing",
        completion: createCompletionPort({ writer, now: () => 2000 }),
      };
    },
  };
}
