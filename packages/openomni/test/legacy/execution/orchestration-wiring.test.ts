import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  spyOn,
} from "bun:test";
import { RunWorker } from "../../../src/legacy/worker/run/run-worker";
import { TaskManager } from "../../../src/legacy/task/manager";
import { TaskStorage } from "../../../src/legacy/task/storage";
import { Session } from "@openomni/session";
import { Observability, AuditLog } from "../../../src/legacy/worker/telemetry";
import { DeadLetterQueue } from "../../../src/legacy/worker/dlq";
import { SummaryDelivery } from "../../../src/legacy/worker/run/summary";

describe("Orchestrator Wiring", () => {
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    spies = [];
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
    spies = [];
  });

  afterAll(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
    spies = [];
  });

  it("wires all lifecycle hooks on successful run", async () => {
    const task = TaskManager.create({
      title: "Test Task",
      owner: { type: "user", id: "user-1" },
      triggers: [{ id: "manual-1", type: "manual" }],
    });

    const triggerResult = await TaskManager.trigger(task.id, {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
    });

    if (!("runId" in triggerResult)) {
      throw new Error("Failed to create run");
    }

    // Restore any existing mocks before creating new ones
    if ((Observability.emitRunEvent as any).mock) {
      (Observability.emitRunEvent as any).mockRestore();
    }
    if ((AuditLog.logPermission as any).mock) {
      (AuditLog.logPermission as any).mockRestore();
    }
    if ((AuditLog.logRunOutcome as any).mock) {
      (AuditLog.logRunOutcome as any).mockRestore();
    }
    if ((SummaryDelivery.persist as any).mock) {
      (SummaryDelivery.persist as any).mockRestore();
    }

    const emitSpy = spyOn(Observability, "emitRunEvent");
    const permissionSpy = spyOn(AuditLog, "logPermission");
    const outcomeSpy = spyOn(AuditLog, "logRunOutcome");
    const persistSpy = spyOn(SummaryDelivery, "persist");
    spies.push(emitSpy, permissionSpy, outcomeSpy, persistSpy);

    await RunWorker.run(
      {
        taskId: task.id,
        runId: triggerResult.runId,
        maxRetries: 0,
      },
      {
        llm: {
          run: async () => ({ type: "stop" as const }),
        },
        input: {},
      },
    );

    expect(permissionSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy.mock.calls[0][1]).toBe("started");
    expect(emitSpy.mock.calls[1][1]).toBe("completed");
    expect(outcomeSpy).toHaveBeenCalledTimes(1);
    expect(outcomeSpy.mock.calls[0][1]).toHaveProperty("success", true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it("wires DLQ and failure hooks on exhausted retries", async () => {
    const task = TaskManager.create({
      title: "Test Task",
      owner: { type: "user", id: "user-1" },
      triggers: [{ id: "manual-1", type: "manual" }],
      policy: {
        retry: {
          maxAttempts: 2,
          backoffMs: { initial: 10, multiplier: 1, max: 10 },
          retryOn: ["transient_error"],
        },
      },
    });

    const triggerResult = await TaskManager.trigger(task.id, {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
    });

    if (!("runId" in triggerResult)) {
      throw new Error("Failed to create run");
    }

    // Restore any existing mocks before creating new ones
    if ((Observability.emitRunEvent as any).mock) {
      (Observability.emitRunEvent as any).mockRestore();
    }
    if ((DeadLetterQueue.add as any).mock) {
      (DeadLetterQueue.add as any).mockRestore();
    }
    if ((AuditLog.logRunOutcome as any).mock) {
      (AuditLog.logRunOutcome as any).mockRestore();
    }
    if ((SummaryDelivery.persist as any).mock) {
      (SummaryDelivery.persist as any).mockRestore();
    }

    const emitSpy = spyOn(Observability, "emitRunEvent");
    const dlqSpy = spyOn(DeadLetterQueue, "add");
    const outcomeSpy = spyOn(AuditLog, "logRunOutcome");
    const persistSpy = spyOn(SummaryDelivery, "persist");
    spies.push(emitSpy, dlqSpy, outcomeSpy, persistSpy);

    await RunWorker.run(
      {
        taskId: task.id,
        runId: triggerResult.runId,
        maxRetries: 1,
      },
      {
        llm: {
          run: async () => {
            throw new Error("Persistent error");
          },
        },
        input: {},
      },
    );

    expect(dlqSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[1][1]).toBe("failed");
    expect(outcomeSpy).toHaveBeenCalledTimes(1);
    expect(outcomeSpy.mock.calls[0][1]).toHaveProperty("success", false);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});
