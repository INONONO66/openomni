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

  test("PermissionDenied parses actor and uses canonical event name", () => {
    const parsed = Tool.Events.PermissionDenied.schema.parse({
      ...base,
      reason: "denied by policy",
    });

    expect(Tool.Events.PermissionDenied.name).toBe("tool.execution.permission_denied");
    expect(parsed.actor).toEqual({ agentName: "researcher" });
    expect(parsed.reason).toBe("denied by policy");
  });
});
