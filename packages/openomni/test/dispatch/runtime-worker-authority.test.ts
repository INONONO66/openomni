import { beforeEach, describe, expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus, Storage, WorkerGrantStore } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { createWorkerRunFixture, input, resetDispatchTestState } from "./runtime-test-fixtures";

describe("DispatchRuntime", () => {
  beforeEach(resetDispatchTestState);

  test("default policy denies worker spawning independent work", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("worker.spawn", () => {
      called = true;
      return { output: "spawned" };
    });

    const result = await runtime.submit(input("worker.spawn"), {
      sessionId: "session-1",
      runId: "run-1",
      agentName: "worker",
    });

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.spawn.denied");
    expect(called).toBe(false);
  });

  test("default policy denies worker spawning even with an explicit matching grant", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("worker.spawn", () => {
      called = true;
      return { output: "spawned" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-worker-spawn",
      workerRunId: "run-1",
      allowedActions: ["worker.spawn"],
      allowedSessionIds: ["parent-session"],
      canCreateExternalTasks: false,
    });

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", parentSessionId: "parent-session" },
        payload: "delegated task",
      },
      { sessionId: "worker-session", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.spawn.denied");
    expect(called).toBe(false);
  });

  test("default policy reserves new Worker allocation for the Resident", async () => {
    for (const actorKind of ["system", "user"] as const) {
      let called = false;
      const runtime = new DispatchRuntime();
      runtime.register("worker.spawn", () => {
        called = true;
        return { output: "spawned" };
      });

      const result = await runtime.submit(
        {
          action: "worker.spawn",
          target: { kind: "worker", parentSessionId: "parent-session" },
          payload: "delegated task",
        },
        { actorKind, actorId: `${actorKind}:test`, sessionId: "session-1" },
      );

      expect(result.status).toBe("denied");
      expect(result.reason).toBe("dispatch.worker.spawn.resident_required");
      expect(called).toBe(false);
    }
  });

  test("default policy denies worker schedule creation", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("schedule.create", () => {
      called = true;
      return { output: "scheduled" };
    });

    const result = await runtime.submit(
      { action: "schedule.create", target: { kind: "schedule", name: "resident" } },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.schedule.denied");
    expect(called).toBe(false);
  });

  test("default policy requires grants for worker egress to existing scopes", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("worker.send", () => {
      called = true;
      return { output: "sent" };
    });

    const denied = await runtime.submit(
      {
        action: "worker.send",
        target: { kind: "worker", sessionId: "child-session" },
        payload: "follow up",
      },
      { sessionId: "parent-session", runId: "run-1", agentName: "worker" },
    );

    expect(denied.status).toBe("denied");
    expect(denied.reason).toBe("dispatch.worker.scope.denied");
    expect(called).toBe(false);

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-worker-send",
      workerRunId: "run-1",
      allowedActions: ["worker.send"],
      allowedSessionIds: ["child-session"],
      canCreateExternalTasks: false,
    });

    const allowed = await runtime.submit(
      {
        action: "worker.send",
        target: { kind: "worker", sessionId: "child-session" },
        payload: "follow up",
      },
      { sessionId: "parent-session", runId: "run-1", agentName: "worker" },
    );

    expect(allowed.status).toBe("completed");
    expect(allowed.output).toBe("sent");
    expect(called).toBe(true);
  });

  test("default policy lets workers ask resident without a grant", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("resident.ask", () => {
      called = true;
      return { output: "answer" };
    });

    const result = await runtime.submit(input("resident.ask"), {
      sessionId: "session-1",
      runId: "run-1",
      agentName: "worker",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("answer");
    expect(called).toBe(true);
  });

  test("default policy denies worker resident.ask to non-resident targets", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("resident.ask", () => {
      called = true;
      return { output: "should not route" };
    });

    const result = await runtime.submit(
      {
        action: "resident.ask",
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "bypass attempt",
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.resident_ask.target.denied");
    expect(called).toBe(false);
  });

  test("default policy denies arbitrary worker dispatch actions fail-closed", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("system.shutdown", () => {
      called = true;
      return { output: "shutdown" };
    });

    const result = await runtime.submit(
      { action: "system.shutdown", target: { kind: "system" } },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.action.denied");
    expect(called).toBe(false);
  });

  test("default policy preserves WorkerGrant store errors as middleware audit evidence", async () => {
    let called = false;
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
    try {
      const runtime = new DispatchRuntime();
      runtime.register("api.ask", () => {
        called = true;
        return { output: "api answer" };
      });

      Storage.initialize({ dbPath: ":memory:" });
      const adapter = Storage.getAdapter();
      if (!adapter.workerGrant) throw new Error("workerGrant adapter missing in test setup");
      Storage.configure({
        ...adapter,
        workerGrant: {
          ...adapter.workerGrant,
          list: () => {
            throw new Error("worker grant adapter unavailable");
          },
        },
      });

      const result = await runtime.submit(
        {
          action: "api.ask",
          target: { kind: "external_actor", id: "api:research" },
        },
        { sessionId: "session-1", runId: "run-1", agentName: "worker" },
      );

      expect(result.status).toBe("denied");
      expect(result.reason).toBe("middleware-error");
      expect(called).toBe(false);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          component: "agent.policy",
          msg: "middleware error",
          context: expect.objectContaining({
            name: "dispatch.default-authority",
            error: "Error: worker grant adapter unavailable",
            failPolicy: "fail-closed",
          }),
        }),
      );
    } finally {
      unsubscribe();
    }
  });
});
