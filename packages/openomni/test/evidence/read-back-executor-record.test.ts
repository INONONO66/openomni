import { afterEach, describe, expect, test } from "bun:test";
import { Storage } from "@openomni/session";
import { ReadBackExecutor } from "../../src/index";
import {
  cleanupReadBackFixtures,
  createWorkItem,
  LOCAL_READ_BACK,
  startFixtureServer,
} from "./read-back-fixture";

afterEach(async () => {
  await cleanupReadBackFixtures();
});

describe("ReadBackExecutor.record", () => {
  test("persists runtime read-back evidence on a work item", async () => {
    Storage.initialize({ dbPath: ":memory:" });
    const origin = await startFixtureServer();
    const item = await createWorkItem();

    const updated = await ReadBackExecutor.record(
      item.hash,
      {
        kind: "url_fetch",
        target: `${origin}/document`,
      },
      LOCAL_READ_BACK,
    );

    const evidence = updated?.evidence.at(-1);
    expect(evidence).toMatchObject({
      kind: "verification",
      passed: true,
      readBack: {
        kind: "url_fetch",
        target: `${origin}/document`,
        passed: true,
        statusCode: 200,
      },
    });
    const readBack = evidence?.readBack;
    if (readBack?.kind !== "url_fetch") throw new Error("expected url_fetch evidence");
    expect(readBack.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
