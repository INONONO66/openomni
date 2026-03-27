import { describe, expect, test } from "bun:test";
import { Agent, Task } from "../src/event/index.js";

const baseEvent = {
  traceId: "trace-1",
  time: 123,
};

describe("Task events", () => {
  test("exposes the created event name and parses payloads", () => {
    expect(Task.Created.name).toBe("task.created");

    const result = Task.Created.schema.parse({
      ...baseEvent,
      payload: {
        id: "task-1",
        name: "Build",
        status: "open",
        description: "Build the app",
      },
    });

    expect(result.payload).toEqual({
      id: "task-1",
      name: "Build",
      status: "open",
      description: "Build the app",
    });
  });

  test("rejects created events without an id", () => {
    expect(() =>
      Task.Created.schema.parse({
        ...baseEvent,
        payload: {
          name: "Build",
          status: "open",
        },
      }),
    ).toThrow();
  });

  test("exposes the updated event name", () => {
    expect(Task.Updated.name).toBe("task.updated");
  });

  test("exposes the deleted event name", () => {
    expect(Task.Deleted.name).toBe("task.deleted");
  });

  test("exposes the run started event name and parses payloads", () => {
    expect(Task.RunStarted.name).toBe("task.run.started");

    const result = Task.RunStarted.schema.parse({
      ...baseEvent,
      payload: {
        id: "run-1",
        taskId: "task-1",
      },
    });

    expect(result.payload).toEqual({
      id: "run-1",
      taskId: "task-1",
    });
  });

  test("rejects run started events without a taskId", () => {
    expect(() =>
      Task.RunStarted.schema.parse({
        ...baseEvent,
        payload: {
          id: "run-1",
        },
      }),
    ).toThrow();
  });

  test("exposes the run completed event name and parses payloads", () => {
    expect(Task.RunCompleted.name).toBe("task.run.completed");

    const result = Task.RunCompleted.schema.parse({
      ...baseEvent,
      payload: {
        id: "run-1",
        taskId: "task-1",
        result: { ok: true },
        duration: 12,
      },
    });

    expect(result.payload).toEqual({
      id: "run-1",
      taskId: "task-1",
      result: { ok: true },
      duration: 12,
    });
  });

  test("rejects run completed events without a duration", () => {
    expect(() =>
      Task.RunCompleted.schema.parse({
        ...baseEvent,
        payload: {
          id: "run-1",
          taskId: "task-1",
          result: { ok: true },
        },
      }),
    ).toThrow();
  });

  test("exposes the run failed event name and parses payloads", () => {
    expect(Task.RunFailed.name).toBe("task.run.failed");

    const result = Task.RunFailed.schema.parse({
      ...baseEvent,
      payload: {
        id: "run-1",
        taskId: "task-1",
        error: "boom",
        duration: 12,
      },
    });

    expect(result.payload).toEqual({
      id: "run-1",
      taskId: "task-1",
      error: "boom",
      duration: 12,
    });
  });

  test("rejects run failed events without an error", () => {
    expect(() =>
      Task.RunFailed.schema.parse({
        ...baseEvent,
        payload: {
          id: "run-1",
          taskId: "task-1",
          duration: 12,
        },
      }),
    ).toThrow();
  });

  test("exposes the scheduled event name", () => {
    expect(Task.RunScheduled.name).toBe("task.run.scheduled");
  });

  test("exposes the blocked event name", () => {
    expect(Task.RunBlocked.name).toBe("task.run.blocked");
  });

  test("exposes the cancelled event name", () => {
    expect(Task.RunCancelled.name).toBe("task.run.cancelled");
  });

  test("exposes the deduped event name", () => {
    expect(Task.RunDeduped.name).toBe("task.run.deduped");
  });

  test("exposes the summary created event name", () => {
    expect(Task.SummaryCreated.name).toBe("task.summary.created");
  });

  test("exposes the summary delivered event name", () => {
    expect(Task.SummaryDelivered.name).toBe("task.summary.delivered");
  });

  test("accepts empty trace ids", () => {
    const result = Task.Deleted.schema.parse({
      traceId: "",
      time: 123,
      payload: {
        id: "task-1",
      },
    });

    expect(result.traceId).toBe("");
  });

  test("accepts negative time values", () => {
    const result = Task.Deleted.schema.parse({
      traceId: "trace-1",
      time: -1,
      payload: {
        id: "task-1",
      },
    });

    expect(result.time).toBe(-1);
  });
});

describe("Agent events", () => {
  test("exposes the router selected event name", () => {
    expect(Agent.RouterSelected.name).toBe("agent.router.selected");
  });

  test("exposes the permission requested event name", () => {
    expect(Agent.PermissionRequested.name).toBe("agent.permission.requested");
  });

  test("exposes the tool executed event name and parses payloads", () => {
    expect(Agent.ToolExecuted.name).toBe("agent.tool.executed");

    const result = Agent.ToolExecuted.schema.parse({
      ...baseEvent,
      payload: {
        agentId: "agent-1",
        toolName: "read_file",
        input: { path: "src/index.ts" },
        output: { ok: true },
        duration: 8,
      },
    });

    expect(result.payload).toEqual({
      agentId: "agent-1",
      toolName: "read_file",
      input: { path: "src/index.ts" },
      output: { ok: true },
      duration: 8,
    });
  });

  test("rejects tool executed events without a duration", () => {
    expect(() =>
      Agent.ToolExecuted.schema.parse({
        ...baseEvent,
        payload: {
          agentId: "agent-1",
          toolName: "read_file",
        },
      }),
    ).toThrow();
  });

  test("accepts negative durations", () => {
    const result = Agent.ToolExecuted.schema.parse({
      ...baseEvent,
      payload: {
        agentId: "agent-1",
        toolName: "read_file",
        duration: -1,
      },
    });

    expect(result.payload.duration).toBe(-1);
  });

  test("accepts empty trace ids on agent events", () => {
    const result = Agent.RouterSelected.schema.parse({
      traceId: "",
      time: 123,
      payload: {
        agentId: "agent-1",
        selectedRoute: "route-a",
      },
    });

    expect(result.traceId).toBe("");
  });
});
