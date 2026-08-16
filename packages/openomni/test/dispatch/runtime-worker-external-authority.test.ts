import { beforeEach, describe, expect, test } from "bun:test";
import { Storage, WorkerGrantStore } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { createWorkerRunFixture, resetDispatchTestState } from "./runtime-test-fixtures";

/** A dispatch inherits the trace of whatever ordered it; the runtime refuses to mint one. */
const TEST_DISPATCH_TRACE_ID = "trace-dispatch-test";

describe("DispatchRuntime", () => {
  beforeEach(resetDispatchTestState);

  test("default policy requires manager grants for worker-created external tasks", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("api.ask", () => {
      called = true;
      return { output: "api answer" };
    });

    const denied = await runtime.submit(
      {
        action: "api.ask",
        target: { kind: "external_actor", id: "api:research" },
        payload: { question: "lookup" },
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "worker",
      },
    );

    expect(denied.status).toBe("denied");
    expect(denied.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create(
      {
        id: "grant-api-ask",
        workerRunId: "run-1",
        allowedActions: ["api.ask"],
        allowedEndpointIds: ["api:research"],
        canCreateExternalTasks: true,
      },
      TEST_DISPATCH_TRACE_ID,
    );

    const allowed = await runtime.submit(
      {
        action: "api.ask",
        target: { kind: "external_actor", id: "api:research" },
        payload: { question: "lookup" },
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "worker",
      },
    );

    expect(allowed.status).toBe("completed");
    expect(allowed.output).toBe("api answer");
    expect(called).toBe(true);
  });

  test("default policy denies worker external grants with empty endpoint scopes", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("api.ask", () => {
      called = true;
      return { output: "api answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create(
      {
        id: "grant-empty-endpoints",
        workerRunId: "run-1",
        allowedActions: ["api.ask"],
        allowedEndpointIds: [],
        canCreateExternalTasks: true,
      },
      TEST_DISPATCH_TRACE_ID,
    );

    const result = await runtime.submit(
      {
        action: "api.ask",
        target: { kind: "external_actor", id: "api:any" },
        payload: { question: "lookup" },
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "worker",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);
  });

  test("default policy denies worker external grants when manager constraints need missing context", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("external.ask", () => {
      called = true;
      return { output: "external answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create(
      {
        id: "grant-manager-constrained",
        workerRunId: "run-1",
        allowedActions: ["external.ask"],
        allowedEndpointIds: ["human:advisor"],
        canCreateExternalTasks: true,
        managerGrant: { allowedActorGroups: ["design"], riskCeiling: "low" },
      },
      TEST_DISPATCH_TRACE_ID,
    );

    const result = await runtime.submit(
      {
        action: "external.ask",
        target: { kind: "external_actor", id: "human:advisor" },
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "worker",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);
  });

  test("default policy does not trust target labels for manager-constrained worker grants", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("external.ask", () => {
      called = true;
      return { output: "external answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create(
      {
        id: "grant-manager-labels",
        workerRunId: "run-1",
        allowedActions: ["external.ask"],
        allowedEndpointIds: ["human:advisor"],
        canCreateExternalTasks: true,
        managerGrant: { allowedActorGroups: ["design"], riskCeiling: "low" },
      },
      TEST_DISPATCH_TRACE_ID,
    );

    const result = await runtime.submit(
      {
        action: "external.ask",
        target: {
          kind: "external_actor",
          id: "human:advisor",
          labels: ["actorGroup:design", "risk:low"],
        },
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "worker",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);
  });

  test("worker grants do not allow new external tasks unless explicitly enabled", async () => {
    const runtime = new DispatchRuntime();
    runtime.register("external.ask", () => ({ output: "should not route" }));
    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create(
      {
        id: "grant-external-followup",
        workerRunId: "run-1",
        allowedActions: ["external.ask"],
        allowedEndpointIds: ["human:advisor"],
        canCreateExternalTasks: false,
      },
      TEST_DISPATCH_TRACE_ID,
    );

    const result = await runtime.submit(
      {
        action: "external.ask",
        target: { kind: "external_actor", id: "human:advisor" },
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "worker",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
  });
});
