import { describe, expect, it, mock } from "bun:test";
import type { Adapter, Tool } from "@openomni/protocol";
import type { NativeTool, ToolProvider } from "@openomni/openomni";
import { buildAgentDef, buildInboundEvent } from "../src/ingress/bridge";

function makeTool(name: string): NativeTool {
  return {
    spec: { name, description: `${name} tool`, inputSchema: {} },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    execute: mock(async (call: Tool.Call) => ({
      id: call.id,
      toolCallId: call.id,
      output: `${name} result`,
    })),
  };
}

function makeProvider(tools: NativeTool[]): ToolProvider {
  return {
    name: "provider",
    category: "system",
    listTools: () => tools,
    execute: mock(async (call: Tool.Call) => ({
      id: call.id,
      toolCallId: call.id,
      output: "result",
    })),
  };
}

function makeMessage(): Adapter.InboundMessage {
  return {
    id: "message-1",
    surfaceKey: "discord:guild:dev",
    text: "hello",
    sender: { id: "user-1", name: "User" },
  };
}

const deps = {
  systemProvider: makeProvider([makeTool("read"), makeTool("bash")]),
  agentProvider: makeProvider([makeTool("subagent")]),
  mcpProvider: makeProvider([makeTool("mcp_search")]),
  customProvider: makeProvider([
    makeTool("spawn_worker"),
    makeTool("send_worker_message"),
    makeTool("cancel_worker"),
    makeTool("resume_worker"),
    makeTool("weather_lookup"),
  ]),
  defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  workspaceRoot: "/workspace",
};

describe("ingress bridge tool surfaces", () => {
  it("keeps in-process Main lightweight with only server custom worker-control tools", () => {
    const event = buildInboundEvent(makeMessage(), "dev", deps);

    expect(event.target).toEqual({ kind: "main" });
    expect(event.agent.tools?.map((tool) => tool.name).sort()).toEqual([
      "cancel_worker",
      "resume_worker",
      "send_worker_message",
      "spawn_worker",
    ]);
  });

  it("keeps full agent tool selection available for spawned workers", () => {
    const { customProvider: _customProvider, ...workerDeps } = deps;
    const workerAgent = buildAgentDef("dev", workerDeps);

    expect(workerAgent.tools?.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "read",
      "subagent",
    ]);
  });
});
