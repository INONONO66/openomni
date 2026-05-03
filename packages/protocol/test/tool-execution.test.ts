import { describe, expect, test } from "bun:test";
import { ToolExecution } from "../src/event/tool.js";

describe("ToolExecution BusEvents", () => {
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
    const parsed = ToolExecution.Started.schema.parse({
      ...base,
      inputSummary: "command: ls",
    });

    expect(parsed.actor).toEqual({ agentName: "researcher" });
    expect(parsed.inputSummary).toBe("command: ls");
  });

  test("PermissionDenied parses actor and uses canonical event name", () => {
    const parsed = ToolExecution.PermissionDenied.schema.parse({
      ...base,
      reason: "denied by policy",
    });

    expect(ToolExecution.PermissionDenied.name).toBe("tool.execution.permission_denied");
    expect(parsed.actor).toEqual({ agentName: "researcher" });
    expect(parsed.reason).toBe("denied by policy");
  });
});
