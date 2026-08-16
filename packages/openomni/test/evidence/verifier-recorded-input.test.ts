import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore, initialize } from "@openomni/session";
import { durableVerifierInput } from "../../src/evidence/verifier-recorded-input";

/**
 * Owning-layer pins for the recorded-verifier-input projection (#606):
 * every refusal branch returns undefined — scope mismatches and malformed
 * durable detail must never produce a verifiable input.
 */

beforeEach(() => {
  Storage.reset();
  initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

async function storedItem(): Promise<WorkItem.Info> {
  const created = await WorkItemStore.create(
    {
      name: "Recorded verifier input",
      sourceMessageId: "evidence:verifier-recorded-input",
      sourceChannel: "dispatch",
      intent: "worker.spawn",
      goal: "pin the durable verifier-input projection",
      executorKind: "internal_chat_agent",
      acceptanceCriteria: ["archived source contains the recorded quote exactly"],
    },
    "trace-test",
  );
  const item = await WorkItemStore.start(created.hash, "trace-test");
  if (!item) throw new Error("missing started fixture item");
  return item;
}

function criterionOf(item: WorkItem.Info): WorkItem.Criterion {
  const criterion = item.completionFacts.criteria[0];
  if (!criterion) throw new Error("missing fixture criterion");
  return criterion;
}

function citationEvidence(
  item: WorkItem.Info,
  criterion: WorkItem.Criterion,
  overrides: Partial<WorkItem.Evidence> = {},
): WorkItem.Evidence {
  return WorkItem.Evidence.parse({
    id: "evidence:citation",
    kind: "verification",
    description: "read-back citation",
    passed: true,
    createdAt: 1_000,
    readBack: {
      kind: "citation_match",
      target: "https://example.com/source",
      quotedText: "the recorded quote",
      matchedText: "the recorded quote",
      passed: true,
      observedAt: 1_000,
      statusCode: 200,
    },
    attempt: item.attempt,
    basisRef: item.completionContract.basisRef,
    criterionId: criterion.id,
    ...overrides,
  });
}

function detailEvidence(item: WorkItem.Info, detail: string): WorkItem.Evidence {
  return WorkItem.Evidence.parse({
    id: "evidence:detail",
    kind: "verification",
    description: "persisted verifier inputs",
    passed: true,
    createdAt: 1_000,
    detail,
    attempt: item.attempt,
    basisRef: item.completionContract.basisRef,
  });
}

function persistedDetail(item: WorkItem.Info, criterion: WorkItem.Criterion): string {
  return JSON.stringify({
    type: "verifier_recorded_inputs",
    version: 1,
    workItemHash: item.hash,
    basisRef: item.completionContract.basisRef,
    criterionId: criterion.id,
    verifierKind: "archived_quote_match",
    recordedInputs: { archivedText: "quote", quotedText: "quote" },
  });
}

describe("durableVerifierInput", () => {
  test("projects a criterion-bound citation read-back", async () => {
    const item = await storedItem();
    const criterion = criterionOf(item);

    expect(durableVerifierInput(item, criterion, citationEvidence(item, criterion))).toEqual({
      kind: "archived_quote_match",
      recordedInputs: {
        archivedText: "the recorded quote",
        quotedText: "the recorded quote",
      },
    });
  });

  test("projects persisted verifier inputs from durable detail", async () => {
    const item = await storedItem();
    const criterion = criterionOf(item);

    expect(
      durableVerifierInput(item, criterion, detailEvidence(item, persistedDetail(item, criterion))),
    ).toEqual({
      kind: "archived_quote_match",
      recordedInputs: { archivedText: "quote", quotedText: "quote" },
    });
  });

  test("refuses evidence from another attempt or basis", async () => {
    const item = await storedItem();
    const criterion = criterionOf(item);

    const staleAttempt = citationEvidence(item, criterion, { attempt: item.attempt + 1 });
    expect(durableVerifierInput(item, criterion, staleAttempt)).toBeUndefined();

    const foreignBasis = citationEvidence(item, criterion, { basisRef: "basis:foreign" });
    expect(durableVerifierInput(item, criterion, foreignBasis)).toBeUndefined();
  });

  test("refuses a citation read-back bound to a different criterion", async () => {
    const item = await storedItem();
    const criterion = criterionOf(item);

    const foreignCriterion = citationEvidence(item, criterion, {
      criterionId: "criterion:other",
    });
    expect(durableVerifierInput(item, criterion, foreignCriterion)).toBeUndefined();
  });

  test("refuses unparseable, mis-scoped, and non-strict durable detail", async () => {
    const item = await storedItem();
    const criterion = criterionOf(item);

    expect(
      durableVerifierInput(item, criterion, detailEvidence(item, "not json at all")),
    ).toBeUndefined();

    const parsed = JSON.parse(persistedDetail(item, criterion)) as Record<string, unknown>;
    for (const tamper of [
      { workItemHash: "hash:foreign" },
      { basisRef: "basis:foreign" },
      { criterionId: "criterion:other" },
      { smuggled: "extra keys fail the strict schema" },
    ]) {
      const detail = JSON.stringify({ ...parsed, ...tamper });
      expect(durableVerifierInput(item, criterion, detailEvidence(item, detail))).toBeUndefined();
    }
  });
});
