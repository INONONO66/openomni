import { describe, test, expect } from "bun:test";
import { Execution } from "./index.js";

describe("Execution", () => {
  test("ExecutionRequest round-trip parse/stringify", () => {
    const request: Execution.Request = {
      runId: "run-123",
      sessionId: "session-456",
      mode: "direct",
      prompt: "What is 2+2?",
      model: {
        provider: "anthropic",
        id: "claude-3-5-sonnet",
      },
      systemPrompt: "You are a helpful assistant.",
      tools: [
        {
          name: "calculator",
          description: "A simple calculator",
          inputSchema: {
            type: "object",
            properties: {
              operation: { type: "string" },
              a: { type: "number" },
              b: { type: "number" },
            },
          },
        },
      ],
      toolConfig: {
        systemTools: ["calculator"],
        workspaceRoot: "/tmp",
      },
      permissions: {
        allowlist: ["calculator"],
      },
      credentials: {
        API_KEY: "secret",
      },
      budget: {
        maxTurns: 10,
        maxTokens: 4000,
      },
      skills: ["math", "reasoning"],
      workspace: "/tmp/workspace",
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed).toEqual(request);

    const json = JSON.stringify(parsed);
    const reparsed = Execution.Request.parse(JSON.parse(json));
    expect(reparsed).toEqual(request);
  });

  test("ExecutionResult round-trip parse/stringify", () => {
    const result: Execution.Result = {
      runId: "run-123",
      sessionId: "session-456",
      status: "succeeded",
      output: "The answer is 4.",
      finishReason: "stop",
      usage: {
        inputTokens: 50,
        outputTokens: 25,
      },
    };

    const parsed = Execution.Result.parse(result);
    expect(parsed).toEqual(result);

    const json = JSON.stringify(parsed);
    const reparsed = Execution.Result.parse(JSON.parse(json));
    expect(reparsed).toEqual(result);
  });

  test("ExecutionRequest with minimal fields", () => {
    const request: Execution.Request = {
      runId: "run-789",
      sessionId: "session-012",
      mode: "plan",
      prompt: "Create a plan",
      model: {
        provider: "openai",
        id: "gpt-4",
      },
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed.runId).toBe("run-789");
    expect(parsed.mode).toBe("plan");
    expect(parsed.tools).toBeUndefined();
  });

  test("ExecutionResult with error status", () => {
    const result: Execution.Result = {
      runId: "run-fail",
      sessionId: "session-fail",
      status: "failed",
      error: "Tool execution timeout",
    };

    const parsed = Execution.Result.parse(result);
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toBe("Tool execution timeout");
    expect(parsed.output).toBeUndefined();
  });

  test("ExecutionRequest rejects invalid mode", () => {
    const invalid = {
      runId: "run-123",
      sessionId: "session-456",
      mode: "invalid",
      prompt: "test",
      model: { provider: "anthropic", id: "claude" },
    };

    expect(() => Execution.Request.parse(invalid)).toThrow();
  });

  test("ExecutionResult rejects invalid status", () => {
    const invalid = {
      runId: "run-123",
      sessionId: "session-456",
      status: "pending",
    };

    expect(() => Execution.Result.parse(invalid)).toThrow();
  });
});
