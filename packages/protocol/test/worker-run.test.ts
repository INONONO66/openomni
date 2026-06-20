import { describe, expect, test } from "bun:test";
import { WorkerRun } from "../src/index.js";

describe("WorkerRun schemas", () => {
  test("Info accepts valid data", () => {
    expect(
      WorkerRun.Info.parse({
        runId: "run-1",
        sessionId: "session-1",
        parentRunId: "run-parent",
        assignedStepId: "step-1",
        title: "Implement feature",
        prompt: "Do the work",
        executorKind: "external_api",
        status: "running",
        startedAt: 1,
        endedAt: 2,
        lastMessageId: "msg-1",
        resumeCount: 2,
      }),
    ).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      parentRunId: "run-parent",
      assignedStepId: "step-1",
      title: "Implement feature",
      prompt: "Do the work",
      executorKind: "external_api",
      status: "running",
      startedAt: 1,
      endedAt: 2,
      lastMessageId: "msg-1",
      resumeCount: 2,
    });
  });

  test("Info defaults resumeCount for legacy data", () => {
    expect(
      WorkerRun.Info.parse({
        runId: "run-1",
        sessionId: "session-1",
        title: "Implement feature",
        prompt: "Do the work",
        status: "running",
        startedAt: 1,
      }),
    ).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      title: "Implement feature",
      prompt: "Do the work",
      status: "running",
      startedAt: 1,
      resumeCount: 0,
    });
  });

  test("Info rejects invalid data", () => {
    expect(
      WorkerRun.Info.safeParse({
        runId: "run-1",
        sessionId: "session-1",
        title: "Implement feature",
        prompt: "Do the work",
        status: "broken",
        startedAt: "now",
        resumeCount: -1,
      }).success,
    ).toBe(false);
  });

  test("Events expose WorkerRun lifecycle descriptors", () => {
    expect(WorkerRun.Events.Started.name).toBe("worker.run.started");
    expect(WorkerRun.Events.Completed.name).toBe("worker.run.completed");
    expect(WorkerRun.Events.Failed.name).toBe("worker.run.failed");
    expect(WorkerRun.Events.Cancelled.name).toBe("worker.run.cancelled");
  });
});
