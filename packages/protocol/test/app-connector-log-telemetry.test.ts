import { describe, expect, test } from "bun:test";
import { AppConnector } from "../src/index.js";

describe("AppConnector log telemetry fields", () => {
  test("spawn can declare a liveness stall timeout", () => {
    const spawn = AppConnector.Spawn.parse({
      command: "agent",
      timeoutMs: 60_000,
      stallTimeoutMs: 5_000,
    });

    expect(spawn.stallTimeoutMs).toBe(5_000);
  });

  test("spawn rejects non-positive liveness stall timeouts", () => {
    expect(() =>
      AppConnector.Spawn.parse({
        command: "agent",
        stallTimeoutMs: 0,
      }),
    ).toThrow();
  });

  test("structured logs can declare token usage and tool call fields", () => {
    const logs = AppConnector.Logs.parse({
      kind: "jsonl",
      path: "stdout",
      eventTimeField: "timestamp",
      messageField: "message",
      tokenUsageField: "usage",
      tokenUsageMode: "delta",
      toolCallField: "tool_call",
    });

    expect(logs).toEqual({
      kind: "jsonl",
      path: "stdout",
      eventTimeField: "timestamp",
      messageField: "message",
      tokenUsageField: "usage",
      tokenUsageMode: "delta",
      toolCallField: "tool_call",
    });
  });

  test("text logs reject structured telemetry fields", () => {
    expect(() =>
      AppConnector.Logs.parse({
        kind: "text",
        path: "agent.log",
        tokenUsageField: "usage",
      }),
    ).toThrow();
  });
});
