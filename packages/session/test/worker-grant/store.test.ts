import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus, Session, Storage, WorkerGrantStore, WorkerRun } from "../../src/index";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

async function createWorkerRun(runId: string, sessionId = `${runId}-session`): Promise<void> {
  const session = Session.create({
    title: sessionId,
    model: { providerID: "test", modelID: "test" },
  });
  await WorkerRun.create(session.id, { runId, title: runId, prompt: "test" });
}

describe("WorkerGrantStore", () => {
  test("evaluates active matching grants and denies revoked grants", async () => {
    await createWorkerRun("run-1");
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

  test("requires explicit manager grant for new external tasks", async () => {
    await createWorkerRun("run-2");
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

    expect(
      WorkerGrantStore.evaluate({
        workerRunId: "run-2",
        action: "external.ask",
        createsExternalTask: true,
        actorGroup: "design",
        risk: "critical",
      } as never),
    ).toMatchObject({ allowed: false, reason: "worker_grant.evaluation.invalid" });
  });

  test("treats explicit empty scope lists as deny-all", async () => {
    await createWorkerRun("run-empty");
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

  test("manager constraints fail closed when evaluation omits required context", async () => {
    await createWorkerRun("run-manager");
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

  test("evaluation stays read-only for past-expiry active grants; cleanup emits expiration", async () => {
    await createWorkerRun("run-expired");
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

    expect(WorkerGrantStore.get("grant-expired")?.status).toBe("active");

    WorkerGrantStore.cleanupExpired("run-expired");
    expect(WorkerGrantStore.get("grant-expired")?.status).toBe("expired");
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toContain("worker_grant.expired");
    expect(events.filter((event) => event === "worker_grant.updated")).toHaveLength(0);
  });

  test("stale direct adapter writes cannot reactivate a revoked grant", async () => {
    await createWorkerRun("run-stale");
    const created = WorkerGrantStore.create({
      id: "grant-stale",
      workerRunId: "run-stale",
      allowedActions: ["worker.send"],
    });
    const staleConcurrentUpdate = {
      ...created,
      status: "active" as const,
      version: created.version + 1,
      updatedAt: Date.now() + 60_000,
    };

    WorkerGrantStore.revoke("grant-stale");
    Storage.get().workerGrant?.set(staleConcurrentUpdate);

    expect(WorkerGrantStore.get("grant-stale")).toMatchObject({
      status: "revoked",
      version: created.version + 1,
    });
  });
});
