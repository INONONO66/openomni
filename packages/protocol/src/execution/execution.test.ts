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
        agentTools: ["delegate"],
        mcpTools: ["search.query"],
        workspaceRoot: "/tmp",
      },
      permissions: {
        action: "tool.call",
        allowlist: ["calculator"],
      },
      credentials: {
        API_KEY: "secret",
      },
      budget: {
        maxTurns: 10,
        maxToolCalls: 20,
      },
      skills: ["math", "reasoning"],
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed).toEqual(request);
    expect(parsed.toolConfig?.agentTools).toEqual(["delegate"]);
    expect(parsed.toolConfig?.mcpTools).toEqual(["search.query"]);

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
      mode: "direct",
      prompt: "Execute a task",
      model: {
        provider: "openai",
        id: "gpt-4",
      },
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed.runId).toBe("run-789");
    expect(parsed.mode).toBe("direct");
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

  test("ExecutionRequest with new fields (agentName, workspaceRoot, middleware)", () => {
    const request: Execution.Request = {
      runId: "run-new",
      sessionId: "session-new",
      mode: "direct",
      prompt: "Execute task",
      model: {
        provider: "anthropic",
        id: "claude-3-5-sonnet",
      },
      agentName: "research-agent",
      workspaceRoot: "/home/user/projects",
      middleware: ["budget", "tool-permission", "memory"],
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed.agentName).toBe("research-agent");
    expect(parsed.workspaceRoot).toBe("/home/user/projects");
    expect(parsed.middleware).toEqual(["budget", "tool-permission", "memory"]);
  });

  test("ExecutionRequest with full Policy.Permission", () => {
    const request: Execution.Request = {
      runId: "run-perms",
      sessionId: "session-perms",
      mode: "direct",
      prompt: "Execute with permissions",
      model: {
        provider: "anthropic",
        id: "claude-3-5-sonnet",
      },
      permissions: {
        action: "tool.call",
        allowlist: ["read_file", "write_file"],
        denylist: ["delete_file"],
        requireApproval: ["execute_command"],
        inputRules: [
          {
            toolPattern: "write_file",
            field: "path",
            pattern: "^/safe/.*",
            action: "allow",
            reason: "Only allow writes to /safe directory",
            priority: 10,
          },
        ],
      },
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed.permissions?.action).toBe("tool.call");
    expect(parsed.permissions?.allowlist).toEqual(["read_file", "write_file"]);
    expect(parsed.permissions?.denylist).toEqual(["delete_file"]);
    expect(parsed.permissions?.requireApproval).toEqual(["execute_command"]);
    expect(parsed.permissions?.inputRules).toHaveLength(1);
    const [inputRule] = parsed.permissions?.inputRules ?? [];
    if (inputRule == null) {
      throw new Error("expected parsed input rule");
    }
    expect(inputRule.toolPattern).toBe("write_file");
  });

  test("ExecutionRequest with full AgentProfile.AgentBudget", () => {
    const request: Execution.Request = {
      runId: "run-budget",
      sessionId: "session-budget",
      mode: "direct",
      prompt: "Execute with budget",
      model: {
        provider: "anthropic",
        id: "claude-3-5-sonnet",
      },
      budget: {
        maxTurns: 20,
        maxToolCalls: 50,
        maxWallTimeMs: 300000,
        maxToolRuntimeMs: 60000,
      },
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed.budget?.maxTurns).toBe(20);
    expect(parsed.budget?.maxToolCalls).toBe(50);
    expect(parsed.budget?.maxWallTimeMs).toBe(300000);
    expect(parsed.budget?.maxToolRuntimeMs).toBe(60000);
  });

  test("ExecutionRequest backward compatibility with inline permissions/budget", () => {
    const request: Execution.Request = {
      runId: "run-compat",
      sessionId: "session-compat",
      mode: "direct",
      prompt: "Legacy request",
      model: {
        provider: "anthropic",
        id: "claude-3-5-sonnet",
      },
      permissions: {
        action: "tool.call",
        allowlist: ["tool1"],
      },
      budget: {
        maxTurns: 5,
      },
    };

    const parsed = Execution.Request.parse(request);
    expect(parsed.permissions?.action).toBe("tool.call");
    expect(parsed.permissions?.allowlist).toEqual(["tool1"]);
    expect(parsed.budget?.maxTurns).toBe(5);
  });
});
