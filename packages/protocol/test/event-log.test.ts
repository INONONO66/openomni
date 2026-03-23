import { describe, expect, it } from "bun:test";
import { ExecutionEvent } from "../src/event-log/index";

const now = new Date().toISOString();

describe("ExecutionEvent schemas", () => {
  it("parses llm_response event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "llm_response",
      turnIndex: 0,
      text: "Hello",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      timestamp: now,
      sequence: 1,
    });
    expect(event.type).toBe("llm_response");
  });

  it("parses tool_started event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "tool_started",
      toolCallId: "call-1",
      toolName: "search",
      timestamp: now,
      sequence: 2,
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
      timestamp: now,
      sequence: 3,
    });
    expect(event.type).toBe("tool_completed");
  });

  it("parses step_completed event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "step_completed",
      stepId: "step-1",
      output: "done",
      timestamp: now,
      sequence: 4,
    });
    expect(event.type).toBe("step_completed");
  });

  it("parses step_failed event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "step_failed",
      stepId: "step-1",
      error: "something went wrong",
      timestamp: now,
      sequence: 5,
    });
    expect(event.type).toBe("step_failed");
  });

  it("parses session_suspended event", () => {
    const event = ExecutionEvent.Schema.parse({
      type: "session_suspended",
      reason: "user requested",
      timestamp: now,
      sequence: 6,
    });
    expect(event.type).toBe("session_suspended");
  });

  it("rejects unknown event type", () => {
    expect(() =>
      ExecutionEvent.Schema.parse({
        type: "unknown_event",
        timestamp: now,
        sequence: 1,
      }),
    ).toThrow();
  });
});
