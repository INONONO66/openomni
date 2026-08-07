import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage, WorkItemStore } from "@openomni/session";
import { ReadBackExecutor } from "../../src/index";
import { cleanupReadBackFixtures, LOCAL_READ_BACK, startFixtureServer } from "./read-back-fixture";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(async () => {
  await cleanupReadBackFixtures();
  Storage.reset();
});

describe("ReadBackExecutor.execute", () => {
  test("returns a read-back check without persisting evidence", async () => {
    const item = await WorkItemStore.create({
      name: "Read-back execution isolation",
      sourceMessageId: "read-back-executor-record-isolation",
      sourceChannel: "test",
      intent: "verify",
      goal: "keep direct read-back execution free of storage side effects",
      acceptanceCriteria: ["the WorkItem remains byte-for-byte unchanged"],
    });
    const before = structuredClone(WorkItemStore.get(item.hash));
    const origin = await startFixtureServer();

    const readBack = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/document`,
      },
      LOCAL_READ_BACK,
    );

    expect(readBack).toMatchObject({
      kind: "url_fetch",
      target: `${origin}/document`,
      passed: true,
      statusCode: 200,
    });
    if (readBack?.kind !== "url_fetch") throw new Error("expected url_fetch evidence");
    expect(readBack.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(WorkItemStore.get(item.hash)).toEqual(before);
  });
});
