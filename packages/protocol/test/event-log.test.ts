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
