/// <reference types="bun" />

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { command, workerSpawnPayload } from "./helpers";

const servers: Server[] = [];
let fixtureRequestCount = 0;

async function startReadBackFixture(): Promise<string> {
  const server = createServer((request, response) => {
    fixtureRequestCount += 1;
    const path = request.url ? new URL(request.url, "http://127.0.0.1").pathname : "/";
    if (path === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("The deployed page includes the expected completion marker.");
      }, 50);
      return;
    }
    if (path === "/missing") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("The marker is absent here.");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("The deployed page includes the expected completion marker.");
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
        if (error) reject(error);
        else resolve();
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

describe("worker.spawn read-back completion gate", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    fixtureRequestCount = 0;
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  test("runs read-back requests before accepting completion reports", async () => {
    const target = await startReadBackFixture();
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                completionReport: {
                  summary: "Published the requested update.",
                  claims: [{ statement: "The deployed page includes the expected marker." }],
                },
                readBackRequests: [
                  {
                    claimIndex: 0,
                    request: {
                      kind: "citation_match",
                      target,
                      quotedText: "expected completion marker",
                    },
                  },
                ],
              }),
            };
          },
        },
      },
      readBack: { allowPrivateNetwork: true },
    });

    const result = await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("publish it")),
    );

    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("completed");
    expect(workItems[0]?.evidence[0]).toMatchObject({
      kind: "verification",
      passed: true,
      readBack: {
        kind: "citation_match",
        target,
        quotedText: "expected completion marker",
        matchedText: "expected completion marker",
      },
    });
    expect(workItems[0]?.completionReport?.claims[0]?.evidenceIds).toEqual([
      workItems[0]?.evidence[0]?.id,
    ]);
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.hash,
        reflection: { workItemStatus: "completed", completionBlocked: false },
      },
    });
  });

  test("blocks completion when read-back evidence fails", async () => {
    const target = `${await startReadBackFixture()}/missing`;
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                completionReport: {
                  summary: "Published the requested update.",
                  claims: [{ statement: "The deployed page includes the expected marker." }],
                },
                readBackRequests: [
                  {
                    claimIndex: 0,
                    request: {
                      kind: "citation_match",
                      target,
                      quotedText: "expected completion marker",
                    },
                  },
                ],
              }),
            };
          },
        },
      },
      readBack: { allowPrivateNetwork: true },
    });

    const result = await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("publish it")),
    );

    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("blocked");
    expect(workItems[0]?.evidence[0]).toMatchObject({
      kind: "verification",
      passed: false,
      readBack: {
        kind: "citation_match",
        target,
        quotedText: "expected completion marker",
      },
    });
    expect(workItems[0]?.completionReport).toBeUndefined();
    expect(workItems[0]?.blockers[0]?.description).toBe(
      `completion report references failed evidence: ${workItems[0]?.evidence[0]?.id}`,
    );
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.hash,
        reflection: { workItemStatus: "blocked", completionBlocked: true },
      },
    });
  });

  test("blocks over-limit read-back request envelopes before execution", async () => {
    const target = await startReadBackFixture();
    for (const readBackRequests of [
      Array.from({ length: 6 }, () => ({
        claimIndex: 0,
        request: { kind: "url_fetch", target },
      })),
      [
        {
          claimIndex: 0,
          request: { kind: "url_fetch", target, timeoutMs: 10_001 },
        },
      ],
      [
        {
          claimIndex: 0,
          request: { kind: "url_fetch", target, maxBodyBytes: 1_000_001 },
        },
      ],
    ] as const) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const registry = new DispatchRegistry();
      registerBuiltInDispatchHandlers(registry, {
        owners: {
          coordinator: {
            async dispatch(_sessionId, request) {
              return {
                runId: request.runId,
                sessionId: request.sessionId,
                status: "succeeded",
                output: JSON.stringify({
                  completionReport: {
                    summary: "Published the requested update.",
                    claims: [{ statement: "The deployed page includes the expected marker." }],
                  },
                  readBackRequests,
                }),
              };
            },
          },
        },
        readBack: { allowPrivateNetwork: true },
      });

      const result = await registry.get("worker.spawn")?.(
        command(
          "worker.spawn",
          { kind: "worker", name: "coder" },
          workerSpawnPayload("publish it"),
        ),
      );

      const workItems = WorkItemStore.list();
      expect(workItems).toHaveLength(1);
      expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("blocked");
      expect(workItems[0]?.evidence).toHaveLength(0);
      expect(workItems[0]?.blockers[0]?.description).toStartWith("completion report is invalid:");
      expect(result).toMatchObject({
        output: {
          workItemHash: workItems[0]?.hash,
          reflection: { workItemStatus: "blocked", completionBlocked: true },
        },
      });
    }
  });

  test("applies one shared deadline across all read-back requests", async () => {
    const target = await startReadBackFixture();
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                completionReport: {
                  summary: "Published the requested update.",
                  claims: [{ statement: "The deployed page includes the expected marker." }],
                },
                readBackRequests: [
                  {
                    claimIndex: 0,
                    request: {
                      kind: "citation_match",
                      target: `${target}/slow`,
                      quotedText: "expected completion marker",
                    },
                  },
                  {
                    claimIndex: 0,
                    request: {
                      kind: "citation_match",
                      target,
                      quotedText: "expected completion marker",
                    },
                  },
                ],
              }),
            };
          },
        },
      },
      readBack: { allowPrivateNetwork: true },
      readBackEnvelopeTimeoutMs: 1,
    });

    const result = await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("publish it")),
    );

    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(fixtureRequestCount).toBe(1);
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("blocked");
    expect(workItems[0]?.evidence).toHaveLength(1);
    expect(workItems[0]?.blockers[0]?.description).toBe("read-back envelope deadline exceeded");
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.hash,
        reflection: { workItemStatus: "blocked", completionBlocked: true },
      },
    });
  });
});
