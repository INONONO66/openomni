/// <reference types="bun" />

import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
import { Storage, WorkItemStore } from "@openomni/session";
import { ReadBackExecutor } from "../../src/index";

const servers: Server[] = [];
const hangingResponses: ServerResponse[] = [];
const slowTimers: ReturnType<typeof setInterval>[] = [];
const LOCAL_READ_BACK = { allowPrivateNetwork: true } satisfies ReadBackExecutor.Options;

async function startFixtureServer(): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ? new URL(request.url, "http://127.0.0.1").pathname : "/";
    if (path === "/document") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("The source contains a quoted passage for citation checks.");
      return;
    }
    if (path === "/api/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, method: request.method }));
      return;
    }
    if (path === "/slow") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      hangingResponses.push(response);
      slowTimers.push(setInterval(() => response.write("x"), 5));
      return;
    }
    if (path === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(1_000_001));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("missing");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fixture server did not bind to a TCP port");
  }
  servers.push(server);
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

async function expectRejects(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return;
  }
  throw new Error("expected operation to reject");
}

async function createWorkItem() {
  return WorkItemStore.create({
    name: "read-back executor test",
    sourceMessageId: "msg-readback",
    sourceChannel: "test",
    intent: "verify",
    goal: "persist runtime read-back evidence",
    acceptanceCriteria: ["The executor records external read-back evidence."],
  });
}

afterEach(async () => {
  Storage.reset();
  for (const timer of slowTimers.splice(0)) {
    clearInterval(timer);
  }
  for (const response of hangingResponses.splice(0)) {
    response.destroy();
  }
  await Promise.all(servers.splice(0).map(closeServer));
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
    await Promise.all(servers.splice(0).map(closeServer));

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
