import { describe, expect, test } from "bun:test";
import { Tool } from "../src/tool/index.js";

describe("Tool.Events BusEvents", () => {
  const base = {
    traceId: "test-trace-id",
    sessionId: "s1",
    runId: "run-1",
    actor: { agentName: "researcher" },
    toolCallId: "tc1",
    toolName: "bash",
    time: Date.now(),
  };

  test("Started parses actor and input summary", () => {
    const parsed = Tool.Events.Started.schema.parse({
      ...base,
      inputSummary: "command: ls",
    });

    expect(parsed.actor).toEqual({ agentName: "researcher" });
    expect(parsed.inputSummary).toBe("command: ls");
  });
});
