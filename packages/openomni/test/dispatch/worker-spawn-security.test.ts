import { beforeEach, describe, expect, test } from "bun:test";
import { Session, Storage, WorkerGrantStore, WorkerRun } from "@openomni/session";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { DispatchRuntime } from "../../src/dispatch/runtime";

async function createWorkerRunFixture(runId = "run-1"): Promise<string> {
  const session = Session.create({
    title: `${runId}-session`,
    model: { providerID: "test", modelID: "test" },
  });
  await WorkerRun.create(session.id, { runId, title: runId, prompt: "test" });
  return session.id;
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

  test("worker spawn grants cannot be widened by payload agentName", async () => {
    const spawnedAgentNames: string[] = [];
    const runtime = createRuntime(spawnedAgentNames);
    const sessionId = await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-worker-spawn-allowed-agent",
      workerRunId: "run-1",
      allowedActions: ["worker.spawn"],
      allowedActorIds: ["allowed-agent"],
      canCreateExternalTasks: false,
    });

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
      { sessionId, runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("worker.spawn payload contains unsupported fields");
    expect(spawnedAgentNames).toEqual([]);
  });

  test("worker spawn grants use target id as the spawned identity", async () => {
    const spawnedAgentNames: string[] = [];
    const runtime = createRuntime(spawnedAgentNames);
    const sessionId = await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-worker-spawn-id",
      workerRunId: "run-1",
      allowedActions: ["worker.spawn"],
      allowedActorIds: ["allowed-agent"],
      canCreateExternalTasks: false,
    });

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", id: "allowed-agent", name: "privileged-agent" },
        payload: {
          text: "delegated task",
          acceptanceCriteria: ["done"],
        },
      },
      { sessionId, runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("completed");
    expect(spawnedAgentNames).toEqual(["allowed-agent"]);
  });

  test("worker spawn grants reject target name when id is outside grant", async () => {
    const spawnedAgentNames: string[] = [];
    const runtime = createRuntime(spawnedAgentNames);
    const sessionId = await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-worker-spawn-name-only",
      workerRunId: "run-1",
      allowedActions: ["worker.spawn"],
      allowedActorIds: ["allowed-agent"],
      canCreateExternalTasks: false,
    });

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", id: "privileged-agent", name: "allowed-agent" },
        payload: {
          text: "delegated task",
          acceptanceCriteria: ["done"],
        },
      },
      { sessionId, runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.spawn.denied");
    expect(spawnedAgentNames).toEqual([]);
  });
});
