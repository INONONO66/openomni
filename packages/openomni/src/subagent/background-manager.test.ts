import { describe, expect, it, beforeEach } from "bun:test";
import { SqliteStorageAdapter } from "@openomni/session/src/storage/sqlite-storage";
import { Storage } from "@openomni/session";
import { BackgroundStore } from "./background-store";
import { BackgroundManager } from "./background-manager";

function makeTask(id: string): import("@openomni/protocol").Subagent.BackgroundTask {
  return {
    id,
    agentName: "test-agent",
    prompt: "do something",
    status: "running",
    parentSessionId: "parent-session-1",
    sessionId: "worker-session-1",
    runId: "run-1",
    queuedAt: Date.now() - 5000,
    startedAt: Date.now() - 4000,
    depth: 0,
  };
}

describe("BackgroundStore — SQLite persistence", () => {
  beforeEach(() => {
    const adapter = new SqliteStorageAdapter(":memory:");
    Storage.configure(adapter);
  });

  it("persists a running task and retrieves it", () => {
    const task = makeTask("bg_test01");
    BackgroundStore.persist(task);

    const found = BackgroundStore.getTask("bg_test01");
    expect(found).toBeDefined();
    expect(found?.id).toBe("bg_test01");
    expect(found?.status).toBe("running");
    expect(found?.agentName).toBe("test-agent");
  });

  it("persists completed task output and retrieves it via getResult", () => {
    const task = {
      ...makeTask("bg_test02"),
      status: "completed" as const,
      completedAt: Date.now(),
    };
    BackgroundStore.persist(task, "the model output");

    const result = BackgroundStore.getResult("bg_test02");
    expect(result).toBeDefined();
    expect(result?.status).toBe("completed");
    expect(result?.output).toBe("the model output");
  });

  it("loadInterrupted marks running tasks as failed with worker restarted error", () => {
    BackgroundStore.persist(makeTask("bg_int01"));
    BackgroundStore.persist(makeTask("bg_int02"));

    const interrupted = BackgroundStore.loadInterrupted();
    expect(interrupted).toHaveLength(2);
    for (const t of interrupted) {
      expect(t.status).toBe("failed");
      expect(t.error).toBe("worker restarted");
    }
  });

  it("loadInterrupted does not return already-terminal tasks", () => {
    const completed = {
      ...makeTask("bg_done"),
      status: "completed" as const,
      completedAt: Date.now(),
    };
    BackgroundStore.persist(completed, "output");
    BackgroundStore.persist(makeTask("bg_running"));

    const interrupted = BackgroundStore.loadInterrupted();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].id).toBe("bg_running");
  });

  it("getResult returns undefined for tasks still in running state", () => {
    BackgroundStore.persist(makeTask("bg_still_running"));
    expect(BackgroundStore.getResult("bg_still_running")).toBeUndefined();
  });
});

describe("BackgroundManager — task survives recreation", () => {
  beforeEach(() => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
  });

  it("getTask returns interrupted task after manager is recreated", () => {
    const task = makeTask("bg_crash01");
    BackgroundStore.persist(task);

    // Simulate worker restart: new manager loads from DB
    const manager = BackgroundManager.create();
    manager.dispose();

    const found = manager.getTask("bg_crash01");
    expect(found).toBeDefined();
    expect(found?.status).toBe("failed");
    expect(found?.error).toBe("worker restarted");
  });

  it("getResult returns failed result for interrupted task after recreation", () => {
    BackgroundStore.persist(makeTask("bg_crash02"));

    const manager = BackgroundManager.create();
    manager.dispose();

    const result = manager.getResult("bg_crash02");
    expect(result).toBeDefined();
    expect(result?.status).toBe("failed");
  });
});
