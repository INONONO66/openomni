import { expect, test } from "bun:test";
import { WorkItemStore } from "@openomni/ledger";
import type { WorkItem } from "@openomni/protocol";
import type { CompletionJudgment } from "../src/work-item/completion";
import {
  type RecordedFixture,
  type RecordedFixtureOptions,
  recordedCompletionSuite,
} from "./helpers/recorded-completion";

const suite = recordedCompletionSuite();

type RecordedRefusalCase = Readonly<{
  name: string;
  options?: RecordedFixtureOptions;
  current: (scope: RecordedFixture) => WorkItem.Info;
  judgment: (scope: RecordedFixture) => CompletionJudgment;
  reason: string;
}>;

const RECORDED_REFUSALS: readonly RecordedRefusalCase[] = [
  {
    name: "a missing result",
    current: ({ item }) => item,
    judgment: ({ item }) => ({
      criterionId: item.completionFacts.criteria[0]?.id ?? "missing",
      value: "recorded",
      resultId: "result:missing",
    }),
    reason: "was not recorded",
  },
  {
    name: "a result that was not verified",
    options: { value: "refuted" },
    current: ({ item }) => item,
    judgment: ({ item, resultId }) => ({
      criterionId: item.completionFacts.criteria[0]?.id ?? "missing",
      value: "recorded",
      resultId,
    }),
    reason: "is not verified",
  },
  {
    name: "a result for another criterion",
    current: ({ item }) => item,
    judgment: ({ item, resultId }) => ({
      criterionId: item.completionFacts.criteria[1]?.id ?? "missing",
      value: "recorded",
      resultId,
    }),
    reason: "belongs to criterion",
  },
  {
    name: "a result from a stale basis",
    current: ({ item }) => ({
      ...item,
      completionContract: { ...item.completionContract, basisRef: "basis:advanced" },
    }),
    judgment: ({ item, resultId }) => ({
      criterionId: item.completionFacts.criteria[0]?.id ?? "missing",
      value: "recorded",
      resultId,
    }),
    reason: "does not match the current basis",
  },
  {
    name: "a result without verifier provenance",
    current: ({ item }) => ({
      ...item,
      completionFacts: {
        ...item.completionFacts,
        results: item.completionFacts.results.map((result, index) => {
          if (index !== 0) return result;
          const { verifierRef: _verifierRef, ...withoutVerifier } = result;
          return withoutVerifier;
        }),
      },
    }),
    judgment: ({ item, resultId }) => ({
      criterionId: item.completionFacts.criteria[0]?.id ?? "missing",
      value: "recorded",
      resultId,
    }),
    reason: "has no verifier reference",
  },
  {
    name: "an invalidated result",
    current: ({ item, resultId }) => ({
      ...item,
      completionFacts: {
        ...item.completionFacts,
        invalidations: [
          ...item.completionFacts.invalidations,
          {
            id: "invalidation:recorded",
            resultId,
            basisRef: item.completionContract.basisRef,
            reason: "artifact changed",
            createdAt: 1500,
          },
        ],
      },
    }),
    judgment: ({ item, resultId }) => ({
      criterionId: item.completionFacts.criteria[0]?.id ?? "missing",
      value: "recorded",
      resultId,
    }),
    reason: "was invalidated",
  },
];

test.each([...RECORDED_REFUSALS])("completion refuses $name", async (scenario) => {
  // Given: one durable candidate violates exactly one recorded-result condition.
  const scope = await suite.fixture(scenario.options);
  const candidate = scenario.current(scope);
  const originalGet = WorkItemStore.get;
  WorkItemStore.get = (workItemId) =>
    workItemId === scope.workItemId ? candidate : originalGet(workItemId);
  try {
    // When: completion attempts to consume it by id.
    const outcome = await scope.completion.complete({
      workItemId: scope.workItemId,
      judgments: [scenario.judgment(scope)],
    });

    // Then: admission refuses before proposing a replacement result.
    expect(outcome).toEqual({ admitted: false, reason: expect.stringContaining(scenario.reason) });
  } finally {
    WorkItemStore.get = originalGet;
  }
});
