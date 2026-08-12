import { describe, expect, test } from "bun:test";
import { WorkerRun } from "../src/index.js";

describe("WorkerRun schemas", () => {
  test("Events expose WorkerRun lifecycle descriptors", () => {
    expect(WorkerRun.Events.Started.name).toBe("worker.run.started");
    expect(WorkerRun.Events.Completed.name).toBe("worker.run.completed");
    expect(WorkerRun.Events.Failed.name).toBe("worker.run.failed");
    expect(WorkerRun.Events.Cancelled.name).toBe("worker.run.cancelled");
  });

  test("Events accept taskId in the shared event envelope", () => {
    expect(
      WorkerRun.Events.Started.schema.parse({
        traceId: "trace-1",
        runId: "run-1",
        taskId: "task-1",
        sessionId: "session-1",
        time: 1,
        payload: {
          sessionId: "session-1",
          runId: "run-1",
          title: "Implement feature",
        },
      }).taskId,
    ).toBe("task-1");
  });

  test("Cancelled events require a worker run id", () => {
    expect(
      WorkerRun.Events.Cancelled.schema.safeParse({
        traceId: "trace-1",
        sessionId: "session-1",
        time: 1,
        payload: {
          sessionId: "session-1",
        },
      }).success,
    ).toBe(false);
  });
});
