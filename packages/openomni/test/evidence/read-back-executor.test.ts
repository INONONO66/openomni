/// <reference types="bun" />

import { createHash } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { Storage, WorkItemStore } from "@openomni/session";
import { ReadBackExecutor } from "../../src/evidence/read-back-executor";
// Deliberate white-box seam: transport and clock injection belong to the private HTTP helper,
// not the kernel package API, and are required for deterministic deadline coverage.
import { loadReadBackUrl } from "../../src/evidence/read-back-http.js";
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
  test("bounds unresolved target validation by the read-back timeout", async () => {
    const result = await loadReadBackUrl(
      "https://example.com/document",
      "GET",
      5,
      1_024,
      false,
      async () =>
        new Promise<never>(() => {
          // Intentionally never settles: the wall-clock deadline must resolve the read-back.
        }),
    );

    expect(result).toEqual({
      statusCode: undefined,
      body: "",
      bodyDigest: undefined,
      complete: false,
    });
  });

  test("bounds unresolved response headers by the read-back timeout", async () => {
    const result = await loadReadBackUrl(
      "http://127.0.0.1/document",
      "GET",
      5,
      1_024,
      true,
      undefined,
      async () =>
        new Promise<never>(() => {
          // Intentionally never settles: active transport cannot extend the wall-clock deadline.
        }),
    );

    expect(result).toEqual({
      statusCode: undefined,
      body: "",
      bodyDigest: undefined,
      complete: false,
    });
  });

  test("rejects response headers fulfilled after the wall-clock deadline", async () => {
    let currentTime = 0;
    const result = await loadReadBackUrl(
      "https://example.com/document",
      "HEAD",
      100,
      1_024,
      false,
      async () => ({
        url: new URL("https://example.com/document"),
        address: "203.0.113.1",
        hostHeader: "example.com",
        serverName: "example.com",
      }),
      () => {
        currentTime = 101;
        const response = new IncomingMessage(new Socket());
        response.statusCode = 200;
        return Promise.resolve(response);
      },
      () => currentTime,
    );

    expect(result).toEqual({
      statusCode: undefined,
      body: "",
      bodyDigest: undefined,
      complete: false,
    });
  });

  test("passes the injected clock through the HTTP request lifecycle", async () => {
    const currentTime = 10;
    let transportTime: number | undefined;
    const result = await loadReadBackUrl(
      "https://example.com/document",
      "HEAD",
      100,
      1_024,
      false,
      async () => ({
        url: new URL("https://example.com/document"),
        address: "203.0.113.1",
        hostHeader: "example.com",
        serverName: "example.com",
      }),
      (_target, _method, _deadlineAt, now) => {
        transportTime = now();
        const response = new IncomingMessage(new Socket());
        response.statusCode = 200;
        return Promise.resolve(response);
      },
      () => currentTime,
    );

    expect(transportTime).toBe(currentTime);
    expect(result.complete).toBe(true);
  });

  test("returns a read-back check without persisting WorkItem evidence", async () => {
    Storage.initialize({ dbPath: ":memory:" });
    const item = await WorkItemStore.create(
      {
        name: "Read-back execution isolation",
        sourceMessageId: "read-back-execution-isolation",
        sourceChannel: "test",
        intent: "verify",
        goal: "keep read-back execution free of storage side effects",
        acceptanceCriteria: ["the executor returns a check without recording evidence"],
      },
      "trace-test",
    );
    const origin = await startFixtureServer();

    const check = await ReadBackExecutor.execute(
      { kind: "url_fetch", target: `${origin}/document` },
      LOCAL_READ_BACK,
    );

    expect(check.passed).toBe(true);
    expect(WorkItemStore.get(item.hash)?.evidence).toEqual([]);
  });

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
