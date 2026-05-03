import { describe, expect, test } from "bun:test";
import { ExecutionEvent } from "../src/event-log/index";

const it = test;

const now = new Date().toISOString();

function baseEvent(actionId: string, sequence: number) {
  return {
    actionId,
    visibility: "internal" as const,
    timestamp: now,
    sequence,
  };
}

describe("ExecutionEvent schemas", () => {
  it("parses llm_response event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "llm_response",
      turnIndex: 0,
      text: "Hello",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ...baseEvent("action-1", 1),
      parentActionId: "turn-action-1",
    });
    expect(event.type).toBe("llm_response");
    expect(event.parentActionId).toBe("turn-action-1");
  });

  it("parses tool_started event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "tool_started",
      toolCallId: "call-1",
      toolName: "search",
      ...baseEvent("tool-action-1", 2),
    });
    expect(event.type).toBe("tool_started");
  });

  it("parses tool_completed event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "tool_completed",
      toolCallId: "call-1",
      result: {
        id: "res-1",
        toolCallId: "call-1",
        output: "result",
        isError: false,
      },
      ...baseEvent("tool-action-2", 3),
    });
    expect(event.type).toBe("tool_completed");
  });

  it("parses step_completed event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "step_completed",
      stepId: "step-1",
      output: "done",
      ...baseEvent("step-action-1", 4),
    });
    expect(event.type).toBe("step_completed");
  });

  it("parses step_failed event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "step_failed",
      stepId: "step-1",
      error: "something went wrong",
      ...baseEvent("step-action-2", 5),
    });
    expect(event.type).toBe("step_failed");
  });

  it("parses session_suspended event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "session_suspended",
      reason: "user requested",
      ...baseEvent("action-6", 6),
    });
    expect(event.type).toBe("session_suspended");
  });

  it("parses generic mirrored bus_event event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "bus_event",
      name: "custom.event",
      payload: { label: "mirrored" },
      ...baseEvent("action-7", 7),
    });
    expect(event).toMatchObject({
      type: "bus_event",
      name: "custom.event",
      payload: { label: "mirrored" },
    });
  });

  it("parses policy_evaluated event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "policy_evaluated",
      policyId: "policy-1",
      actor: { id: "user-1", role: "admin" },
      action: "tool.call",
      resource: "tool.search",
      verdict: "continue",
      reason: "actor has permission",
      ...baseEvent("action-7", 7),
    });
    expect(event).toMatchObject({
      type: "policy_evaluated",
      policyId: "policy-1",
      verdict: "continue",
      resource: "tool.search",
    });
  });

  it("parses action_requested event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "action_requested",
      actor: { id: "agent-1", role: "worker" },
      action: "tool.call",
      resource: "tool.write",
      input: { path: "file.txt" },
      ...baseEvent("action-request-1", 8),
    });
    expect(event).toMatchObject({
      type: "action_requested",
      action: "tool.call",
      resource: "tool.write",
      input: { path: "file.txt" },
    });
  });

  it("parses action_blocked event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "action_blocked",
      policyId: "policy-2",
      actor: { id: "user-2", role: "guest" },
      action: "tool.call",
      resource: "tool.delete",
      verdict: "abort",
      reason: "insufficient permissions",
      ...baseEvent("action-8", 8),
    });
    expect(event).toMatchObject({
      type: "action_blocked",
      verdict: "abort",
      resource: "tool.delete",
    });
  });

  it("parses action_rewritten event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "action_rewritten",
      policyId: "policy-3",
      actor: { id: "user-3" },
      action: "tool.call",
      resource: "tool.search",
      verdict: "transform",
      reason: "query sanitized",
      before: { query: "SELECT * FROM users" },
      after: { query: "SELECT name FROM users" },
      ...baseEvent("action-9", 9),
    });
    expect(event).toMatchObject({
      type: "action_rewritten",
      before: { query: "SELECT * FROM users" },
      after: { query: "SELECT name FROM users" },
      resource: "tool.search",
    });
  });

  it("parses action_approved event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "action_approved",
      policyId: "policy-4",
      actor: { id: "user-4", role: "admin" },
      action: "tool.call",
      resource: "tool.admin_tool",
      verdict: "continue",
      reason: "admin override approved",
      ...baseEvent("action-10", 10),
    });
    expect(event).toMatchObject({
      type: "action_approved",
      reason: "admin override approved",
      resource: "tool.admin_tool",
    });
  });

  it("parses worker_run_created event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "worker_run_created",
      runId: "run-1",
      title: "worker task",
      prompt: "do the thing",
      assignedStepId: "step-1",
      startedAt: 1234567890,
      ...baseEvent("worker-action-1", 11),
    });
    expect(event).toMatchObject({
      type: "worker_run_created",
      runId: "run-1",
      title: "worker task",
      startedAt: 1234567890,
    });
  });

  it("parses worker_run_status_changed event for starting", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "worker_run_status_changed",
      runId: "run-1",
      status: "starting",
      ...baseEvent("worker-action-2", 12),
    });
    expect(event).toMatchObject({
      type: "worker_run_status_changed",
      status: "starting",
    });
  });

  it("parses worker_run_status_changed event for running with lastMessageId", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "worker_run_status_changed",
      runId: "run-1",
      status: "running",
      lastMessageId: "msg-1",
      ...baseEvent("worker-action-3", 13),
    });
    expect(event).toMatchObject({
      type: "worker_run_status_changed",
      status: "running",
      lastMessageId: "msg-1",
    });
  });

  it("parses worker_run_status_changed event for waiting_input", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "worker_run_status_changed",
      runId: "run-1",
      status: "waiting_input",
      ...baseEvent("worker-action-4", 14),
    });
    expect(event).toMatchObject({
      type: "worker_run_status_changed",
      status: "waiting_input",
    });
  });

  it("parses worker_run_completed event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "worker_run_completed",
      runId: "run-1",
      status: "succeeded",
      endedAt: 1234567900,
      lastMessageId: "msg-2",
      ...baseEvent("worker-action-5", 15),
    });
    expect(event).toMatchObject({
      type: "worker_run_completed",
      status: "succeeded",
      endedAt: 1234567900,
    });
  });

  it("parses worker_run_failed event with error", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "worker_run_failed",
      runId: "run-1",
      status: "failed",
      error: "timeout",
      endedAt: 1234567910,
      ...baseEvent("worker-action-6", 16),
    });
    expect(event).toMatchObject({
      type: "worker_run_failed",
      status: "failed",
      error: "timeout",
    });
  });

  it("parses worker_run_failed event with cancelled status", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "worker_run_failed",
      runId: "run-2",
      status: "cancelled",
      ...baseEvent("worker-action-7", 17),
    });
    expect(event).toMatchObject({
      type: "worker_run_failed",
      status: "cancelled",
    });
  });

  it("rejects unknown event type", () => {
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "unknown_event",
        ...baseEvent("action-unknown", 1),
      }),
    ).toThrow();
  });
});

describe("required field rejection", () => {
  it("llm_response: missing text rejects", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "llm_response",
        turnIndex: 0,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        actionId: "action-1",
        visibility: "internal",
        timestamp: "x",
        sequence: 1,
      }),
    ).toThrow());
  it("tool_started: missing toolCallId rejects", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "tool_started",
        toolName: "x",
        actionId: "tool-action-1",
        visibility: "internal",
        timestamp: "x",
        sequence: 1,
      }),
    ).toThrow());
  it("tool_completed: missing result rejects", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "tool_completed",
        toolCallId: "c",
        actionId: "tool-action-2",
        visibility: "internal",
        timestamp: "x",
        sequence: 1,
      }),
    ).toThrow());
  it("missing actionId rejects", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "session_suspended",
        reason: "r",
        visibility: "internal",
        timestamp: "x",
        sequence: 1,
      }),
    ).toThrow());
  it("invalid visibility rejects", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "session_suspended",
        reason: "r",
        actionId: "action-1",
        visibility: "public",
        timestamp: "x",
        sequence: 1,
      }),
    ).toThrow());
});

describe("discriminator coverage", () => {
  it("all event types are supported", () => {
    const supportedTypes = [
      "llm_response",
      "tool_started",
      "tool_completed",
      "step_completed",
      "step_failed",
      "session_suspended",
      "bus_event",
      "action_requested",
      "policy_evaluated",
      "action_blocked",
      "action_rewritten",
      "action_approved",
      "worker_run_created",
      "worker_run_status_changed",
      "worker_run_completed",
      "worker_run_failed",
    ];

    for (const type of supportedTypes) {
      let event: unknown;
      if (type === "llm_response") {
        event = {
          type,
          turnIndex: 0,
          text: "test",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          ...baseEvent("action-1", 1),
        };
      } else if (type === "tool_started") {
        event = {
          type,
          toolCallId: "call-1",
          toolName: "test",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "tool_completed") {
        event = {
          type,
          toolCallId: "call-1",
          result: {
            id: "res-1",
            toolCallId: "call-1",
            output: "result",
            isError: false,
          },
          ...baseEvent("action-1", 1),
        };
      } else if (type === "step_completed") {
        event = {
          type,
          stepId: "step-1",
          output: "done",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "step_failed") {
        event = {
          type,
          stepId: "step-1",
          error: "failed",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "session_suspended") {
        event = {
          type,
          reason: "test",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "bus_event") {
        event = {
          type,
          name: "custom.event",
          payload: { label: "test" },
          ...baseEvent("action-1", 1),
        };
      } else if (type === "action_requested") {
        event = {
          type,
          actor: {},
          action: "test",
          resource: "test.resource",
          input: {},
          ...baseEvent("action-1", 1),
        };
      } else if (type === "policy_evaluated") {
        event = {
          type,
          policyId: "p-1",
          actor: {},
          action: "test",
          resource: "test.resource",
          verdict: "continue",
          reason: "test",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "action_blocked") {
        event = {
          type,
          policyId: "p-1",
          actor: {},
          action: "test",
          resource: "test.resource",
          verdict: "abort",
          reason: "test",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "action_rewritten") {
        event = {
          type,
          policyId: "p-1",
          actor: {},
          action: "test",
          resource: "test.resource",
          verdict: "transform",
          reason: "test",
          before: {},
          after: {},
          ...baseEvent("action-1", 1),
        };
      } else if (type === "action_approved") {
        event = {
          type,
          policyId: "p-1",
          actor: {},
          action: "test",
          resource: "test.resource",
          verdict: "continue",
          reason: "test",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "worker_run_created") {
        event = {
          type,
          runId: "run-1",
          title: "test",
          prompt: "test",
          startedAt: 1234567890,
          ...baseEvent("action-1", 1),
        };
      } else if (type === "worker_run_status_changed") {
        event = {
          type,
          runId: "run-1",
          status: "running",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "worker_run_completed") {
        event = {
          type,
          runId: "run-1",
          status: "succeeded",
          ...baseEvent("action-1", 1),
        };
      } else if (type === "worker_run_failed") {
        event = {
          type,
          runId: "run-1",
          status: "failed",
          ...baseEvent("action-1", 1),
        };
      }

      expect(() => ExecutionEvent.Schema.parse(event)).not.toThrow(`Failed to parse ${type}`);
    }
  });
});

describe("acceptance (documents current behavior)", () => {
  it("sequence accepts float (bare z.number())", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "session_suspended",
        reason: "r",
        actionId: "action-1",
        visibility: "internal",
        timestamp: "x",
        sequence: 1.5,
      }),
    ).not.toThrow());
  it("sequence accepts negative", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "session_suspended",
        reason: "r",
        actionId: "action-1",
        visibility: "internal",
        timestamp: "x",
        sequence: -1,
      }),
    ).not.toThrow());
  it("timestamp accepts empty string (no format validation)", () =>
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "session_suspended",
        reason: "r",
        actionId: "action-1",
        visibility: "internal",
        timestamp: "",
        sequence: 1,
      }),
    ).not.toThrow());
});
