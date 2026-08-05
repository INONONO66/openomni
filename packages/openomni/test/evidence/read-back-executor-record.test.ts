import { afterEach, describe, expect, test } from "bun:test";
import { ReadBackExecutor } from "../../src/index";
import { cleanupReadBackFixtures, LOCAL_READ_BACK, startFixtureServer } from "./read-back-fixture";

afterEach(async () => {
  await cleanupReadBackFixtures();
});

describe("ReadBackExecutor.execute", () => {
  test("returns a read-back check without persisting evidence", async () => {
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
  });
});
