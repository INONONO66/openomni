import { describe, expect, test } from "bun:test";
import { Execution } from "./index.js";

describe("Execution log telemetry", () => {
  test("local CLI log events can carry normalized usage and tool calls", () => {
    const event = Execution.LogEvent.parse({
      kind: "local_cli_log_event",
      artifactId: "art-log",
      message: "tool completed",
      sequence: 0,
      data: { message: "tool completed" },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolCall: {
        id: "call-1",
        tool: "bash",
        status: "completed",
        input: { command: "bun test" },
        output: "pass",
      },
    });

    expect(event.usage?.totalTokens).toBe(15);
    expect(event.toolCall?.tool).toBe("bash");
  });
});
