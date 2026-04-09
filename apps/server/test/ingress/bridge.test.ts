import { describe, expect, it } from "bun:test";
import type { Adapter } from "@openomni/protocol";
import { buildInboundEvent, type BridgeDeps } from "../../src/ingress/bridge";
import { AgentToolProvider } from "../../src/tool/agent/provider";
import { McpToolProvider } from "../../src/tool/mcp/provider";
import { SystemToolProvider } from "../../src/tool/system/provider";

const workspaceRoot = "/workspace/openomni";

function createDeps(): BridgeDeps {
  return {
    systemProvider: new SystemToolProvider(workspaceRoot),
    agentProvider: new AgentToolProvider(),
    mcpProvider: new McpToolProvider(),
    workspaceRoot,
  };
}

function createMessage(overrides: Partial<Adapter.InboundMessage>): Adapter.InboundMessage {
  return {
    id: crypto.randomUUID(),
    surfaceKey: "telegram:bot-1:chat:chat-1",
    text: "hello",
    sender: { id: "user-1", name: "Test User" },
    ...overrides,
  };
}

describe("buildInboundEvent", () => {
  it("builds a direct event for telegram messages", () => {
    const event = buildInboundEvent(createMessage({}), "dev", createDeps());

    expect(event.mode).toBe("direct");
    if (event.mode !== "direct") throw new Error("expected direct event");

    expect(event.surface).toBe("telegram");
    expect(event.workspace).toBe("bot-1");
    expect(event.channel).toBe("chat-1");
    expect(event.payload).toBe("hello");
    expect(event.meta?.kind).toBe("chat");
    expect(event.agent.systemPrompt).toBeDefined();
    expect(event.agent.toolExecutor).toBeDefined();
    expect(event.agent.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["bash", "read", "write", "edit", "grep_search", "glob", "subagent"]),
    );
  });

  it("builds a plan event for discord slash mode", () => {
    const event = buildInboundEvent(
      createMessage({
        surfaceKey: "discord:guild-1:channel:channel-1",
        text: "/plan build auth",
      }),
      "dev",
      createDeps(),
    );

    expect(event.mode).toBe("plan");
    if (event.mode !== "plan") throw new Error("expected plan event");

    expect(event.surface).toBe("discord");
    expect(event.workspace).toBe("guild-1");
    expect(event.channel).toBe("channel-1");
    expect(event.payload).toBe("build auth");
    expect(event.agent.toolExecutor).toBeDefined();
  });

  it("builds a team event and reuses the same agent config", () => {
    const event = buildInboundEvent(
      createMessage({
        surfaceKey: "discord:guild-2:channel:channel-9",
        text: "/team run",
      }),
      "dev",
      createDeps(),
    );

    expect(event.mode).toBe("team");
    if (event.mode !== "team") throw new Error("expected team event");

    expect(event.payload).toBe("run");
    expect(event.agents.reviewer).toEqual(event.agents.executor);
    expect(event.agents.reviewer.toolExecutor).toBeDefined();
  });
});
