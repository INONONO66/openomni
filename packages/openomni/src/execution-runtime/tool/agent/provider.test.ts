import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { AgentToolProvider } from "./provider.js";
import type { NativeTool } from "../types.js";

function makeCall(tool: string): Tool.Call {
  return { id: "call-1", tool, input: {} };
}

function makeTool(name: string): NativeTool {
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier: 0,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    source: "agent",
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `${name}-result`,
    }),
  };
}

describe("AgentToolProvider", () => {
  it("includes the built-in subagent tool", () => {
    const provider = new AgentToolProvider();
    const tools = provider.listTools();

    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.spec.name === "subagent")).toBe(true);
  });

  it("register appends an extra tool to the list", () => {
    const provider = new AgentToolProvider();
    provider.register(makeTool("my-agent-tool"));

    const tools = provider.listTools();

    expect(tools.some((t) => t.spec.name === "my-agent-tool")).toBe(true);
  });

  it("name and category metadata are correct", () => {
    const provider = new AgentToolProvider();

    expect(provider.name).toBe("agent");
    expect(provider.category).toBe("agent");
  });

  it("execute returns error for unknown tool", async () => {
    const provider = new AgentToolProvider();

    const result = await provider.execute(makeCall("nonexistent"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: nonexistent");
  });

  it("execute dispatches to a registered tool", async () => {
    const provider = new AgentToolProvider();
    provider.register(makeTool("helper-agent"));

    const result = await provider.execute(makeCall("helper-agent"));

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("helper-agent-result");
  });

  it("execute forwards execution context to registered tools", async () => {
    const provider = new AgentToolProvider();
    let capturedSignal: AbortSignal | undefined;
    provider.register({
      ...makeTool("helper-agent"),
      execute: async (call, context) => {
        capturedSignal = context?.signal;
        return { id: crypto.randomUUID(), toolCallId: call.id, output: "ok" };
      },
    });
    const controller = new AbortController();

    const result = await provider.execute(makeCall("helper-agent"), { signal: controller.signal });

    expect(result.output).toBe("ok");
    expect(capturedSignal).toBe(controller.signal);
  });

  it("execute resolves underscore-to-dot alias for registered tools", async () => {
    const provider = new AgentToolProvider();
    provider.register(makeTool("my.agent.tool"));

    const result = await provider.execute(makeCall("my_agent_tool"));

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("my.agent.tool-result");
  });
});
