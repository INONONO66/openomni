/// <reference types="bun" />

import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { ReadBackExecutor } from "../../src/index";
import {
  cleanupReadBackFixtures,
  closeFixtureServers,
  expectRejects,
  LOCAL_READ_BACK,
  startFixtureServer,
} from "./read-back-fixture";

afterEach(async () => {
  await cleanupReadBackFixtures();
});

describe("ReadBackExecutor", () => {
  test("re-fetches a URL and records status plus content digest", async () => {
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/document`,
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "url_fetch",
      target: `${origin}/document`,
      passed: true,
      statusCode: 200,
    });
    if (check.kind !== "url_fetch") throw new Error("expected url_fetch check");
    expect(check.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("marks a URL fetch as failed when the source returns a non-success status", async () => {
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/missing`,
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "url_fetch",
      target: `${origin}/missing`,
      passed: false,
      statusCode: 404,
    });
    if (check.kind !== "url_fetch") throw new Error("expected url_fetch check");
    expect(check.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("marks a URL fetch as failed without digest when no response is observed", async () => {
    const origin = await startFixtureServer();
    await closeFixtureServers();

    const check = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/document`,
        timeoutMs: 100,
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "url_fetch",
      target: `${origin}/document`,
      passed: false,
    });
    if (check.kind !== "url_fetch") throw new Error("expected url_fetch check");
    expect(check.statusCode).toBeUndefined();
    expect(check.contentDigest).toBeUndefined();
  });

  test("marks transport failures as failed read-back results", async () => {
    const origin = await startFixtureServer();
    await closeFixtureServers();

    const check = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/document`,
        timeoutMs: 100,
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "url_fetch",
      target: `${origin}/document`,
      passed: false,
    });
    if (check.kind !== "url_fetch") throw new Error("expected url_fetch check");
    expect(check.statusCode).toBeUndefined();
    expect(check.contentDigest).toBeUndefined();
  });

  test("uses timeoutMs as a wall-clock deadline", async () => {
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/slow`,
        timeoutMs: 20,
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "url_fetch",
      target: `${origin}/slow`,
      passed: false,
      statusCode: 200,
    });
    if (check.kind !== "url_fetch") throw new Error("expected url_fetch check");
    expect(check.contentDigest).toBeUndefined();
  });

  test("fails oversized read-back bodies without digesting partial content", async () => {
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/large`,
        maxBodyBytes: 32,
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "url_fetch",
      target: `${origin}/large`,
      passed: false,
      statusCode: 200,
    });
    if (check.kind !== "url_fetch") throw new Error("expected url_fetch check");
    expect(check.contentDigest).toBeUndefined();
  });

  test("digests the raw response bytes instead of decoded text", async () => {
    const origin = await startFixtureServer();
    const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x61]);

    const check = await ReadBackExecutor.execute(
      {
        kind: "url_fetch",
        target: `${origin}/binary`,
      },
      LOCAL_READ_BACK,
    );

    if (check.kind !== "url_fetch") throw new Error("expected url_fetch check");
    expect(check.contentDigest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });

  test("re-queries an HTTP API endpoint and records a response digest", async () => {
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      {
        kind: "api_query",
        target: `${origin}/api/status`,
        method: "GET",
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "api_query",
      target: `${origin}/api/status`,
      method: "GET",
      passed: true,
      statusCode: 200,
    });
    if (check.kind !== "api_query") throw new Error("expected api_query check");
    expect(check.responseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("rejects mutating API read-back methods", async () => {
    const origin = await startFixtureServer();
    const input = JSON.parse(
      JSON.stringify({
        kind: "api_query",
        target: `${origin}/api/status`,
        method: "POST",
      }),
    );

    await expectRejects(ReadBackExecutor.execute(input, LOCAL_READ_BACK));
  });

  test("rejects non-HTTP read-back targets", async () => {
    await expectRejects(
      ReadBackExecutor.execute({
        kind: "url_fetch",
        target: "ftp://example.com/document",
      }),
    );
  });

  test("rejects malformed read-back targets with validation errors", () => {
    return expect(
      ReadBackExecutor.execute({
        kind: "url_fetch",
        target: "not a url",
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  test("rejects private network read-back targets by default", async () => {
    await expectRejects(
      ReadBackExecutor.execute({
        kind: "url_fetch",
        target: "http://127.0.0.1/document",
      }),
    );
  });

  test("matches quoted citation text against the fetched source", async () => {
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      {
        kind: "citation_match",
        target: `${origin}/document`,
        quotedText: "quoted passage",
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "citation_match",
      target: `${origin}/document`,
      quotedText: "quoted passage",
      matchedText: "quoted passage",
      passed: true,
      statusCode: 200,
    });
  });

  test("fails citation checks when the quote is absent", async () => {
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      {
        kind: "citation_match",
        target: `${origin}/document`,
        quotedText: "not in the source",
      },
      LOCAL_READ_BACK,
    );

    expect(check).toMatchObject({
      kind: "citation_match",
      target: `${origin}/document`,
      quotedText: "not in the source",
      passed: false,
      statusCode: 200,
    });
    expect(check.matchedText).toBeUndefined();
  });
});
