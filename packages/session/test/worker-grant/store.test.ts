import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus, Storage, WorkerGrantStore } from "../../src/index";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("WorkerGrantStore", () => {
  test("evaluates active matching grants and denies revoked grants", () => {
    WorkerGrantStore.create({
      id: "grant-1",
      workerRunId: "run-1",
      allowedActions: ["worker.send"],
      allowedSessionIds: ["session-1"],
    });

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-1",
        action: "worker.send",
        sessionId: "session-1",
      }),
    ).toMatchObject({ allowed: true, grantId: "grant-1" });

    WorkerGrantStore.revoke("grant-1");

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-1",
        action: "worker.send",
        sessionId: "session-1",
      }),
    ).toMatchObject({ allowed: false });
  });

  test("requires explicit manager grant for new external tasks", () => {
    WorkerGrantStore.create({
      id: "grant-2",
      workerRunId: "run-2",
      allowedActions: ["external.ask"],
      canCreateExternalTasks: true,
      managerGrant: { allowedActorGroups: ["design"], riskCeiling: "low" },
    });

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-2",
        action: "external.ask",
        createsExternalTask: true,
        actorGroup: "design",
        risk: "low",
      }),
    ).toMatchObject({ allowed: true });

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-2",
        action: "external.ask",
        createsExternalTask: true,
        actorGroup: "legal",
        risk: "low",
      }),
    ).toMatchObject({ allowed: false, reason: "worker_grant.actor_group.denied" });

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-2",
        action: "external.ask",
        createsExternalTask: true,
        actorGroup: "design",
        risk: "medium",
      }),
    ).toMatchObject({ allowed: false, reason: "worker_grant.risk.denied" });
  });

  test("treats explicit empty scope lists as deny-all", () => {
    WorkerGrantStore.create({
      id: "grant-empty-endpoints",
      workerRunId: "run-empty",
      allowedActions: ["api.ask"],
      allowedEndpointIds: [],
      canCreateExternalTasks: true,
    });

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-empty",
        action: "api.ask",
        endpointId: "api:any",
        createsExternalTask: true,
      }),
    ).toMatchObject({ allowed: false, reason: "worker_grant.endpoint.denied" });
  });

  test("manager constraints fail closed when evaluation omits required context", () => {
    WorkerGrantStore.create({
      id: "grant-manager-context",
      workerRunId: "run-manager",
      allowedActions: ["external.ask"],
      allowedEndpointIds: ["human:advisor"],
      canCreateExternalTasks: true,
      managerGrant: { allowedActorGroups: ["design"], riskCeiling: "low" },
    });

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-manager",
        action: "external.ask",
        endpointId: "human:advisor",
        createsExternalTask: true,
      }),
    ).toMatchObject({ allowed: false, reason: "worker_grant.actor_group.denied" });
  });

  test("evaluation durably expires past-expiry active grants", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WorkerGrantStore.create({
      id: "grant-expired",
      workerRunId: "run-expired",
      allowedActions: ["worker.send"],
      allowedSessionIds: ["session-1"],
      expiresAt: Date.now() - 1,
    });

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-expired",
        action: "worker.send",
        sessionId: "session-1",
      }),
    ).toMatchObject({ allowed: false, reason: "worker_grant.inactive" });

    expect(WorkerGrantStore.get("grant-expired")?.status).toBe("expired");
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toContain("worker_grant.expired");
  });
});
