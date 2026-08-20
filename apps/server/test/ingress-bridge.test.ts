import { describe, expect, it, mock } from "bun:test";
import type { Channel, Tool } from "@openomni/protocol";
import type { NativeTool, ToolProvider } from "@openomni/openomni";
import { registerAgent } from "../src/agents";
import { agentMetadata, getAgentDefinition } from "../src/agents/registry";
import { buildAgentDef, buildInboundEvent, buildResidentAgentDef } from "../src/ingress/bridge";

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

function makeMessage(): Channel.InboundMessage {
  return {
    id: "message-1",
    traceId: "trace-test",
    surfaceKey: "discord:guild:channel:dev",
    text: "hello",
    sender: { id: "user-1", name: "User" },
    replyToId: "outbound-question",
    threadId: "thread-1",
    raw: {
      target: { kind: "worker", sessionId: "worker-session-1", runId: "worker-run-1" },
      correlationToken: "worker-correlation-token",
    },
  };
}

const deps = {
  systemProvider: makeProvider([makeTool("read"), makeTool("bash")]),
  agentProvider: makeProvider([makeTool("dispatch")]),
  mcpProvider: makeProvider([makeTool("mcp_search")]),
  customProvider: makeProvider([makeTool("custom_probe")]),
  defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  workspaceRoot: "/workspace",
};

describe("ingress bridge transport boundary", () => {
  it("preserves normalized transport facts without assigning a route", () => {
    const message = makeMessage();
    const event = buildInboundEvent(message);

    expect(event).toMatchObject({
      id: "message-1",
      mode: "direct",
      surface: "discord",
      workspace: "guild",
      channel: "dev",
      userId: "user-1",
      payload: "hello",
    });
    expect(event.meta).toMatchObject({
      actor: { role: "user", id: "user-1" },
      agentName: "resident",
      surfaceKey: "discord:guild:channel:dev",
      kind: "channel",
      sender: message.sender,
      replyToId: "outbound-question",
      threadId: "thread-1",
      raw: message.raw,
      correlation: {
        endpointId: "guild",
        channelId: "dev",
        replyToMessageId: "outbound-question",
        threadId: "thread-1",
        tokenHash: "worker-correlation-token",
        externalConversationId: "discord:guild:channel:dev",
      },
    });
    expect("target" in event).toBe(false);
    expect(event.meta && "target" in event.meta).toBe(false);
    expect(event.meta && "pendingAsk" in event.meta).toBe(false);
    expect("externalMessageId" in event).toBe(false);
    expect(event.meta && "externalMessageId" in event.meta).toBe(false);
    const correlation = event.meta?.correlation;
    if (typeof correlation !== "object" || correlation === null) throw new Error("shape");
    expect("externalMessageId" in correlation).toBe(false);
  });

  it("preserves a descriptor-only thread hint in event and correlation metadata", () => {
    const message = makeMessage();
    message.surfaceKey = "discord:guild:channel:dev:thread:descriptor-thread";
    message.threadId = undefined;

    const event = buildInboundEvent(message);

    expect(event.meta?.threadId).toBe("descriptor-thread");
    const correlation = event.meta?.correlation;
    if (typeof correlation !== "object" || correlation === null || !("threadId" in correlation)) {
      throw new Error("shape");
    }
    expect(correlation.threadId).toBe("descriptor-thread");
  });

  it("stamps meta.inboundTreatment from a message marked evidence_only (audit A T1)", () => {
    const message = makeMessage();
    message.inboundTreatment = "evidence_only";

    const event = buildInboundEvent(message);

    expect(event.meta?.inboundTreatment).toBe("evidence_only");
  });

  it("leaves meta.inboundTreatment absent for normal (unmarked) traffic", () => {
    const event = buildInboundEvent(makeMessage());

    expect(event.meta?.inboundTreatment).toBeUndefined();
  });

  it("prefers an explicit message thread hint over a conflicting descriptor hint", () => {
    const message = makeMessage();
    message.surfaceKey = "discord:guild:channel:dev:thread:descriptor-thread";
    message.threadId = "explicit-thread";

    const event = buildInboundEvent(message);

    expect(event.meta?.threadId).toBe("explicit-thread");
    const correlation = event.meta?.correlation;
    if (typeof correlation !== "object" || correlation === null || !("threadId" in correlation)) {
      throw new Error("shape");
    }
    expect(correlation.threadId).toBe(event.meta?.threadId);
  });

  it("constructs the Resident agent brain-side from the same bridge deps (#707: never on the event)", () => {
    const event = buildInboundEvent(makeMessage());

    // The perimeter event carries only the agent NAME; the AgentDef itself is
    // brain material, resolved via buildResidentAgentDef behind the injected
    // external agent resolver.
    expect(event.meta?.agentName).toBe("resident");
    expect("agent" in event).toBe(false);

    const agent = buildResidentAgentDef(deps);
    expect(agent.systemPrompt).toContain("Resident");
    expect(agent.tools?.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "custom_probe",
      "dispatch",
      "mcp_search",
      "read",
    ]);
  });

  it("keeps DOTTED spec names in the AgentDef — the llm wire boundary owns sanitize", () => {
    // A dotted native/MCP name (`grep.search`) must survive into the AgentDef
    // unchanged: the provider-pattern coercion belongs solely to the
    // `@openomni/llm` wire boundary (#749), so policy/dispatch/transcript keep
    // the native dotted vocabulary. Pre-reconcile the bridge underscored here.
    const dottedDeps = {
      ...deps,
      systemProvider: makeProvider([makeTool("read"), makeTool("grep.search")]),
    };
    const agent = buildResidentAgentDef(dottedDeps);
    const names = agent.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("grep.search");
    expect(names).not.toContain("grep_search");
  });

  it("keeps full agent tool selection available for spawned workers", () => {
    const { customProvider: _customProvider, ...workerDeps } = deps;
    const workerAgent = buildAgentDef("dev", workerDeps);

    expect(workerAgent.tools?.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "dispatch",
      "read",
    ]);
  });

  it("propagates per-agent policy plans into ingress agent definitions", () => {
    const originalDev = getAgentDefinition("dev");
    const originalDevMeta = agentMetadata.get("dev");
    if (!originalDev || !originalDevMeta) {
      throw new Error("expected dev agent fixture");
    }

    try {
      registerAgent(
        () => ({
          name: "dev",
          description: "Policy test agent",
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
          systemPrompt: "Follow the policy plan.",
          tools: { categories: ["filesystem"] },
          permissions: { action: "tool.call", allowlist: ["read"] },
          policyPlan: {
            policies: [{ id: "builtin:tool-permission", required: true }],
            labels: ["policy-dev"],
          },
        }),
        { name: "dev", description: "Policy test agent" },
      );

      const workerAgent = buildAgentDef("dev", deps);

      expect(workerAgent.permissions).toEqual({ action: "tool.call", allowlist: ["read"] });
      expect(workerAgent.policyPlan).toEqual({
        policies: [{ id: "builtin:tool-permission", required: true }],
        labels: ["policy-dev"],
      });
    } finally {
      registerAgent(() => originalDev, originalDevMeta);
    }
  });
});
