import { beforeEach, describe, expect, test } from "bun:test";
import { Session, Storage } from "@openomni/ledger";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { DispatchRuntime } from "../../src/dispatch/runtime";

/** A dispatch inherits the trace of whatever ordered it; the runtime refuses to mint one. */
const TEST_DISPATCH_TRACE_ID = "trace-dispatch-test";

function createSession(): string {
  return Session.create({
    traceId: TEST_DISPATCH_TRACE_ID,
    title: "resident-session",
    model: { providerID: "test", modelID: "test" },
  }).id;
}

function createRuntime(spawnedAgentNames: string[]): DispatchRuntime {
  const runtime = new DispatchRuntime();
  const handlers = createWorkerDispatchHandlers({
    coordinator: {
      async dispatch(_sessionId, request) {
        if (request.agentName) spawnedAgentNames.push(request.agentName);
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "succeeded",
          output: "spawned",
        };
      },
    },
  });
  runtime.register("worker.spawn", handlers["worker.spawn"]);
  return runtime;
}

describe("worker.spawn security", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("spawn payload cannot override the target agent identity", async () => {
    const spawnedAgentNames: string[] = [];
    const runtime = createRuntime(spawnedAgentNames);
    const sessionId = createSession();

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", name: "allowed-agent" },
        payload: {
          text: "delegated task",
          acceptanceCriteria: ["done"],
          agentName: "privileged-agent",
        },
      },
      { traceId: TEST_DISPATCH_TRACE_ID, sessionId, agentName: "resident" },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("worker.spawn payload contains unsupported fields");
    expect(spawnedAgentNames).toEqual([]);
  });

  test("authorized spawn uses target id instead of the display name", async () => {
    const spawnedAgentNames: string[] = [];
    const runtime = createRuntime(spawnedAgentNames);
    const sessionId = createSession();

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", id: "allowed-agent", name: "privileged-agent" },
        payload: {
          text: "delegated task",
          acceptanceCriteria: ["done"],
        },
      },
      { traceId: TEST_DISPATCH_TRACE_ID, sessionId, agentName: "resident" },
    );

    expect(result.status).toBe("completed");
    expect(spawnedAgentNames).toEqual(["allowed-agent"]);
  });
});
