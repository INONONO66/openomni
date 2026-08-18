/// <reference types="bun" />

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/ledger";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers as registerBuiltInDispatchHandlersProduction } from "../../src/dispatch/setup";
import { allocateTestAttempt, command } from "./helpers";

const servers: Server[] = [];
let completionWriter: Storage.WorkItemCompletionWriter;

function registerBuiltInDispatchHandlers(
  registry: Parameters<typeof registerBuiltInDispatchHandlersProduction>[0],
  options?: Parameters<typeof registerBuiltInDispatchHandlersProduction>[1],
) {
  return registerBuiltInDispatchHandlersProduction(registry, {
    completionWriter,
    ...options,
  });
}

function workerSpawnPayload(text: string) {
  return {
    text,
    acceptanceCriteria: ["archived source contains the recorded quote exactly"],
  };
}
const criterionFacts = [
  {
    criterionIndex: 0,
    evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
    verification: { kind: "archived_quote_match" },
  },
] as const;

async function startReadBackFixture(): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ? new URL(request.url, "http://127.0.0.1").pathname : "/";
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
    completionWriter = Storage.initialize({ dbPath: ":memory:" });
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
                  claims: [{ statement: "archived source contains the recorded quote exactly" }],
                },
                criterionFacts,
                readBackRequests: [
                  {
                    claimIndex: 0,
                    criterionIndex: 0,
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
    const readBackEvidenceId = workItems[0]?.evidence[0]?.id;
    if (readBackEvidenceId === undefined) throw new Error("shape");
    expect(workItems[0]?.completionReport?.claims[0]?.evidenceIds).toEqual([readBackEvidenceId]);
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.workItemId,
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
                criterionFacts,
                readBackRequests: [
                  {
                    claimIndex: 0,
                    criterionIndex: 0,
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
      `read-back verifier evidence did not pass: ${workItems[0]?.evidence[0]?.id}`,
    );
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.workItemId,
        reflection: { workItemStatus: "blocked", completionBlocked: true },
      },
    });
  });

  test("composition root shares the injected read-back recorder and clock across Worker origins", async () => {
    const registry = new DispatchRegistry();
    const recordedHashes: string[] = [];
    const now = () => 5_000;
    const completionOutput = () =>
      JSON.stringify({
        completionReport: {
          summary: "Published the requested update.",
          claims: [{ statement: "archived source contains the recorded quote exactly" }],
        },
        criterionFacts,
        readBackRequests: [
          {
            claimIndex: 0,
            criterionIndex: 0,
            request: {
              kind: "citation_match",
              target: "http://127.0.0.1:1/read-back",
              quotedText: "expected completion marker",
            },
          },
        ],
      });
    registerBuiltInDispatchHandlers(registry, {
      now,
      async readBackRecorder(hash, request) {
        recordedHashes.push(hash);
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItem.ReadBackCheck.parse({
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: now(),
          statusCode: 200,
        });
      },
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: completionOutput(),
            };
          },
        },
      },
    });

    await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("publish it")),
    );
    const internal = WorkItemStore.list()[0];
    if (!internal) throw new Error("missing internal WorkItem");

    const connectorCreated = await WorkItemStore.create(
      {
        name: "Connector read-back composition",
        sourceMessageId: "dispatch:connector-read-back-composition",
        sourceChannel: "dispatch",
        intent: "worker.complete",
        goal: "prove connector read-back composition",
        executorKind: "connector_endpoint",
        workSessionId: "session:connector-read-back",
        workerRunId: "run:connector-read-back",
        acceptanceCriteria: ["archived source contains the recorded quote exactly"],
      },
      "trace-test",
    );
    const connector = await WorkItemStore.start(connectorCreated.workItemId, "trace-test");
    if (!connector) throw new Error("missing connector WorkItem");
    Storage.getAdapter().session.set("session:connector-read-back", {
      id: "session:connector-read-back",
      title: "Connector read-back composition",
      model: { providerID: "test", modelID: "test" },
      time: { created: 1, updated: 1 },
      spawnDepth: 0,
    });
    // #510 D2b — the active run is the WorkItem attempt, not a
    // worker_run_state row (the worker-run store is frozen).
    await allocateTestAttempt(connector.workItemId);
    await registry.get("worker.complete")?.({
      ...command(
        "worker.complete",
        {
          kind: "worker",
          runId: "run:connector-read-back",
          sessionId: "session:connector-read-back",
        },
        {
          workItemHash: connector.workItemId,
          result: {
            runId: "run:connector-read-back",
            sessionId: "session:connector-read-back",
            status: "succeeded",
            output: completionOutput(),
          },
        },
      ),
      actor: {
        kind: "internal_worker",
        actorId: "session:connector-read-back:run:connector-read-back",
        sessionId: "session:connector-read-back",
        runId: "run:connector-read-back",
        workerRunId: "run:connector-read-back",
        trustTier: "assigned_worker",
      },
    });

    const internalStored = WorkItemStore.get(internal.workItemId);
    const connectorStored = WorkItemStore.get(connector.workItemId);
    expect(recordedHashes).toEqual([internal.workItemId, connector.workItemId]);
    expect(internalStored ? WorkItem.deriveStatus(internalStored) : undefined).toBe("completed");
    expect(connectorStored ? WorkItem.deriveStatus(connectorStored) : undefined).toBe("completed");
    expect(internalStored?.completionFacts.admissions[0]?.createdAt).toBe(5_000);
    expect(connectorStored?.completionFacts.admissions[0]?.createdAt).toBe(5_000);
  });

  test("blocks over-limit read-back request envelopes before execution", async () => {
    const target = await startReadBackFixture();
    for (const readBackRequests of [
      Array.from({ length: 6 }, () => ({
        claimIndex: 0,
        criterionIndex: 0,
        request: { kind: "url_fetch", target },
      })),
      [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: { kind: "url_fetch", target, timeoutMs: 10_001 },
        },
      ],
      [
        {
          claimIndex: 0,
          criterionIndex: 0,
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
                  criterionFacts,
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
          workItemHash: workItems[0]?.workItemId,
          reflection: { workItemStatus: "blocked", completionBlocked: true },
        },
      });
    }
  });
});
