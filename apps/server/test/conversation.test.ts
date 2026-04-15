import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IngressEngine } from "@openomni/openomni";
import type { Adapter } from "@openomni/protocol";
import { createMessageHandler } from "../src/handler/conversation";
import { AgentToolProvider } from "../src/tool/agent/provider";
import { McpToolProvider } from "../src/tool/mcp/provider";
import { SystemToolProvider } from "../src/tool/system/provider";
import { createToolExecutor } from "../src/tool/executor";
import { getAgentDefinition, getAllAgentNames } from "../src/agents/registry";
import type { NativeTool, ToolProvider, ToolRiskTier } from "../src/tool/types";
import type { AgentDefinition, AgentToolSelection } from "../src/agents/types";

function createMockTool(name: string, riskTier: ToolRiskTier = 0): NativeTool {
  return {
    spec: { name, inputSchema: { type: "object" } },
    prompt: `Use ${name}`,
    riskTier,
    isReadOnly: riskTier === 0,
    isDestructive: false,
    isConcurrencySafe: riskTier === 0,
    source: "system",
    execute: (call) =>
      Promise.resolve({ id: crypto.randomUUID(), toolCallId: call.id, output: `${name} result` }),
  };
}

function createMockProvider(
  name: string,
  category: "system" | "agent" | "mcp",
  tools: NativeTool[],
): ToolProvider {
  return {
    name,
    category,
    listTools: () => tools,
    execute: (call) => {
      const tool = tools.find((t) => t.spec.name === call.tool);
      return tool
        ? tool.execute(call)
        : Promise.resolve({
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: "not found",
            isError: true,
          });
    },
  };
}

function buildToolsForAgent(agentDef: AgentDefinition, providers: ToolProvider[]): NativeTool[] {
  const selected: NativeTool[] = [];

  for (const provider of providers) {
    const selection = agentDef.tools[provider.category as keyof AgentToolSelection];
    if (selection === true) {
      selected.push(...provider.listTools());
    } else if (Array.isArray(selection)) {
      selected.push(...provider.listTools().filter((t) => selection.includes(t.spec.name)));
    }
  }

  return selected;
}

describe("agent registry", () => {
  it("lists all registered agent names", () => {
    const names = getAllAgentNames();
    expect(names).toContain("dev");
    expect(names.length).toBeGreaterThan(0);
  });

  it("returns AgentDefinition for known agent", () => {
    const def = getAgentDefinition("dev");
    expect(def).toBeDefined();
    expect(def?.name).toBe("dev");
    expect(def?.systemPrompt.length).toBeGreaterThan(0);
  });

  it("returns undefined for unknown agent", () => {
    const def = getAgentDefinition("nonexistent");
    expect(def).toBeUndefined();
  });

  it("dev agent has expected tool selection", () => {
    const def = getAgentDefinition("dev");
    expect(def).toBeDefined();
    expect(def?.tools.system).toBe(true);
    expect(def?.tools.agent).toEqual(["subagent"]);
    expect(def?.tools.mcp).toBe(false);
  });
});

describe("tool selection by agent definition", () => {
  const systemTools = [
    createMockTool("read"),
    createMockTool("write", 1),
    createMockTool("bash", 2),
  ];
  const agentTools = [createMockTool("subagent"), createMockTool("delegate")];
  const mcpTools = [createMockTool("mcp.search")];

  const providers: ToolProvider[] = [
    createMockProvider("system", "system", systemTools),
    createMockProvider("agent", "agent", agentTools),
    createMockProvider("mcp", "mcp", mcpTools),
  ];

  it("system: true selects all system tools", () => {
    const def: AgentDefinition = {
      name: "test",
      description: "",
      model: { provider: "anthropic", id: "test" },
      systemPrompt: "test",
      tools: { system: true, agent: false, mcp: false },
    };

    const tools = buildToolsForAgent(def, providers);
    const names = tools.map((t) => t.spec.name);

    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("bash");
    expect(names).not.toContain("subagent");
    expect(names).not.toContain("mcp.search");
  });

  it("agent: string[] selects only named tools", () => {
    const def: AgentDefinition = {
      name: "test",
      description: "",
      model: { provider: "anthropic", id: "test" },
      systemPrompt: "test",
      tools: { system: false, agent: ["subagent"], mcp: false },
    };

    const tools = buildToolsForAgent(def, providers);
    const names = tools.map((t) => t.spec.name);

    expect(names).toEqual(["subagent"]);
  });

  it("false selection returns no tools from that category", () => {
    const def: AgentDefinition = {
      name: "test",
      description: "",
      model: { provider: "anthropic", id: "test" },
      systemPrompt: "test",
      tools: { system: false, agent: false, mcp: false },
    };

    const tools = buildToolsForAgent(def, providers);

    expect(tools).toHaveLength(0);
  });
});

describe("agent permissions applied to executor", () => {
  it("executor with agent budget config respects timeout overrides", async () => {
    const slowTool: NativeTool = {
      spec: { name: "slow", inputSchema: { type: "object" } },
      prompt: "Use slow",
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "system",
      execute: () => new Promise((resolve) => setTimeout(resolve, 5000)),
    };

    const executor = createToolExecutor({
      tools: [slowTool],
      config: { timeoutMs: { tier0: 30 } },
    });

    const result = await executor({
      id: crypto.randomUUID(),
      tool: "slow",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("timeout");
  });
});

describe("createMessageHandler", () => {
  const originalIngest = IngressEngine.ingest;
  const deps = {
    systemProvider: new SystemToolProvider("/workspace/openomni"),
    agentProvider: new AgentToolProvider(),
    mcpProvider: new McpToolProvider(),
    workspaceRoot: "/workspace/openomni",
    defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  };

  function createMessage(
    text: string,
    surfaceKey = "discord:guild-1:channel:general",
  ): Adapter.InboundMessage {
    return {
      id: crypto.randomUUID(),
      surfaceKey,
      text,
      sender: { id: "user-1", name: "Test User" },
    };
  }

  beforeEach(() => {
    IngressEngine.ingest = originalIngest;
  });

  afterEach(() => {
    IngressEngine.ingest = originalIngest;
  });

  it("returns direct output from IngressEngine", async () => {
    const handler = createMessageHandler(deps);
    const events: Array<Parameters<typeof IngressEngine.ingest>[0]> = [];

    IngressEngine.ingest = async (event) => {
      events.push(event);
      return {
        mode: "direct",
        sessionId: "session-1",
        result: { output: "hello from ingress", finishReason: "stop" },
      };
    };

    expect(await handler(createMessage("hello"))).toEqual({ text: "hello from ingress" });
    expect(events).toHaveLength(1);
    expect(events[0]?.mode).toBe("direct");
  });

  it("acknowledges plan ingress results", async () => {
    const handler = createMessageHandler(deps);

    IngressEngine.ingest = async (event) => {
      if (event.mode === "plan") {
        return {
          mode: "plan",
          sessionId: "session-plan",
          result: {
            plan: {
              planId: "plan-1",
              goal: "build auth",
              steps: [],
              createdAt: new Date(),
              version: 1,
            },
          },
        };
      }
      throw new Error("unexpected mode");
    };

    expect(await handler(createMessage("/plan build auth"))).toEqual({
      text: "Plan generated: build auth",
    });
  });

  it("serializes concurrent messages per surface key", async () => {
    const handler = createMessageHandler(deps);
    const order: string[] = [];
    let active = 0;
    let signalFirstStart!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStart = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    IngressEngine.ingest = async (event) => {
      const payload = String(event.payload);
      active += 1;
      order.push(`start:${payload}`);
      expect(active).toBe(1);
      if (payload === "first") {
        signalFirstStart();
        await firstGate;
      }
      order.push(`end:${payload}`);
      active -= 1;
      return {
        mode: "direct",
        sessionId: `session-${payload}`,
        result: { output: payload, finishReason: "stop" },
      };
    };

    const first = handler(createMessage("first", "discord:guild-1:channel:queue"));
    const second = handler(createMessage("second", "discord:guild-1:channel:queue"));

    await firstStarted;
    expect(order).toEqual(["start:first"]);

    releaseFirst();

    expect(await first).toEqual({ text: "first" });
    expect(await second).toEqual({ text: "second" });
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });
});
