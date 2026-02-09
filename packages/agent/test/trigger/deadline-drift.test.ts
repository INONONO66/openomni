import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Scheduler } from "../../src/trigger/scheduler";
import { Task } from "../../src/task/types";
import { TaskManager } from "../../src/task/manager";
import { IngressEngine } from "../../src/ingress/engine";

describe("Scheduler - Deadline Drift Warning", () => {
  let originalDateNow: typeof Date.now;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalDateNow = Date.now;
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    Date.now = originalDateNow;
    consoleWarnSpy.mockRestore();
  });

  test("should log warning when drift exceeds 5 minutes", async () => {
    const taskId = "task-drift-1";
    const trigger: Task.TriggerInterval = {
      id: "trigger-1",
      type: "interval",
      ms: 60000,
    };

    const baseTime = 1000000000000;
    Date.now = () => baseTime;

    const ingestSpy = spyOn(IngressEngine, "ingest").mockResolvedValue(
      undefined,
    );

    Scheduler.registerTrigger(taskId, trigger);

    const expectedNextFire = baseTime + trigger.ms;
    const driftMs = 6 * 60 * 1000;
    const actualFireTime = expectedNextFire + driftMs;
    Date.now = () => actualFireTime;

    await Scheduler.fire(taskId, trigger);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const warnCall = consoleWarnSpy.mock.calls[0][0] as string;
    expect(warnCall).toContain("Deadline drift detected");
    expect(warnCall).toContain(`task=${taskId}`);
    expect(warnCall).toContain(`trigger=${trigger.id}`);
    expect(warnCall).toContain(`driftMs=${driftMs}`);

    ingestSpy.mockRestore();
  });

  test("should not log warning when drift is below 5 minutes", async () => {
    const taskId = "task-no-drift";
    const trigger: Task.TriggerInterval = {
      id: "trigger-2",
      type: "interval",
      ms: 60000,
    };

    const baseTime = 1000000000000;
    Date.now = () => baseTime;

    const ingestSpy = spyOn(IngressEngine, "ingest").mockResolvedValue(
      undefined,
    );

    Scheduler.registerTrigger(taskId, trigger);

    const expectedNextFire = baseTime + trigger.ms;
    const driftMs = 4 * 60 * 1000;
    const actualFireTime = expectedNextFire + driftMs;
    Date.now = () => actualFireTime;

    await Scheduler.fire(taskId, trigger);

    expect(consoleWarnSpy).not.toHaveBeenCalled();

    ingestSpy.mockRestore();
  });

  test("should include expectedAt and actualAt timestamps in warning", async () => {
    const taskId = "task-drift-2";
    const trigger: Task.TriggerInterval = {
      id: "trigger-3",
      type: "interval",
      ms: 5 * 60 * 1000,
    };

    const baseTime = 1000000000000;
    Date.now = () => baseTime;

    const ingestSpy = spyOn(IngressEngine, "ingest").mockResolvedValue(
      undefined,
    );

    Scheduler.registerTrigger(taskId, trigger);

    const expectedNextFire = baseTime + trigger.ms;
    const driftMs = 7 * 60 * 1000;
    const actualTime = expectedNextFire + driftMs;
    Date.now = () => actualTime;

    await Scheduler.fire(taskId, trigger);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const warnCall = consoleWarnSpy.mock.calls[0][0] as string;
    expect(warnCall).toContain("expectedAt=");
    expect(warnCall).toContain("actualAt=");
    expect(warnCall).toContain(new Date(expectedNextFire).toISOString());
    expect(warnCall).toContain(new Date(actualTime).toISOString());

    ingestSpy.mockRestore();
  });

  test("should not log warning for unregistered triggers", async () => {
    const taskId = "task-unregistered";
    const trigger: Task.TriggerOnce = {
      id: "trigger-4",
      type: "once",
      at: Date.now() + 10000,
    };

    const ingestSpy = spyOn(IngressEngine, "ingest").mockResolvedValue(
      undefined,
    );

    await Scheduler.fire(taskId, trigger);

    expect(consoleWarnSpy).not.toHaveBeenCalled();

    ingestSpy.mockRestore();
  });
});
