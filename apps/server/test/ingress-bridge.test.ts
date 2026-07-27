import { createHash } from "node:crypto";
import { describe, expect, it, mock } from "bun:test";
import { Operational, type Adapter, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { NativeTool, ToolProvider } from "@openomni/openomni";
import { registerAgent } from "../src/agents";
import { agentMetadata, getAgentDefinition } from "../src/agents/registry";
import {
  BridgeAgentResolutionError,
  buildAgentDef,
  buildInboundEvent,
  buildResidentAgentDef,
} from "../src/ingress/bridge";

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
    surfaceKey: "discord:guild:channel:dev",
    text: "hello",
    sender: { id: "user-1", name: "User" },
    media: [{ kind: "image", url: "https://example.test/image.png" }],
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
  customProvider: makeProvider([makeTool("weather_lookup")]),
  defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  workspaceRoot: "/workspace",
};

const CORRELATION_TOKEN_HASH_DOMAIN = "openomni.ingress.correlation-token.v1\0";

function hashCorrelationToken(token: string): string {
  return createHash("sha256").update(CORRELATION_TOKEN_HASH_DOMAIN).update(token).digest("hex");
}

describe("ingress bridge transport boundary", () => {
  it("preserves normalized transport facts without assigning a route", () => {
    const message = makeMessage();
    const event = buildInboundEvent(message, deps);

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
      media: message.media,
      replyToId: "outbound-question",
      threadId: "thread-1",
      raw: {
        target: { kind: "worker", sessionId: "worker-session-1", runId: "worker-run-1" },
      },
      correlation: {
        endpointId: "guild",
        channelId: "dev",
        replyToMessageId: "outbound-question",
        threadId: "thread-1",
        tokenHash: hashCorrelationToken("worker-correlation-token"),
        externalConversationId: "discord:guild:channel:dev",
      },
    });
    expect("target" in event).toBe(false);
    expect(event.meta && "target" in event.meta).toBe(false);
    expect(event.meta && "pendingAsk" in event.meta).toBe(false);
    expect("externalMessageId" in event).toBe(false);
    expect(event.meta && "externalMessageId" in event.meta).toBe(false);
    expect(event.meta?.correlation && "externalMessageId" in event.meta.correlation).toBe(false);
  });

  it("hashes equal correlation tokens identically without disclosing the raw token", () => {
    const first = buildInboundEvent(makeMessage(), deps).meta?.correlation?.tokenHash;
    const second = buildInboundEvent(makeMessage(), deps).meta?.correlation?.tokenHash;

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("worker-correlation-token");
    expect(JSON.stringify(buildInboundEvent(makeMessage(), deps))).not.toContain(
      "worker-correlation-token",
    );
    expect(first).not.toBe(createHash("sha256").update("worker-correlation-token").digest("hex"));
  });

  it("hashes distinct correlation tokens differently", () => {
    const firstMessage = makeMessage();
    const secondMessage = makeMessage();
    secondMessage.raw = { correlationToken: "different-correlation-token" };

    const first = buildInboundEvent(firstMessage, deps).meta?.correlation?.tokenHash;
    const second = buildInboundEvent(secondMessage, deps).meta?.correlation?.tokenHash;

    expect(first).not.toBe(second);
  });

  it("does not add a token hash when the raw correlation token is absent", () => {
    const message = makeMessage();
    message.raw = { transportFact: "safe" };

    const correlation = buildInboundEvent(message, deps).meta?.correlation;

    expect(correlation && "tokenHash" in correlation).toBe(false);
  });

  it("preserves a descriptor-only thread hint in event and correlation metadata", () => {
    const message = makeMessage();
    message.surfaceKey = "discord:guild:channel:dev:thread:descriptor-thread";
    message.threadId = undefined;

    const event = buildInboundEvent(message, deps);

    expect(event.meta?.threadId).toBe("descriptor-thread");
    expect(event.meta?.correlation?.threadId).toBe("descriptor-thread");
  });

  it("prefers an explicit message thread hint over a conflicting descriptor hint", () => {
    const message = makeMessage();
    message.surfaceKey = "discord:guild:channel:dev:thread:descriptor-thread";
    message.threadId = "explicit-thread";

    const event = buildInboundEvent(message, deps);

    expect(event.meta?.threadId).toBe("explicit-thread");
    expect(event.meta?.correlation?.threadId).toBe(event.meta?.threadId);
  });

  it("constructs the Resident agent from normalized transport facts", () => {
    const event = buildInboundEvent(makeMessage(), deps);

    expect(event.meta?.agentName).toBe("resident");
    expect(event.agent.systemPrompt).toContain("Resident");
    expect(event.agent.model).toEqual(deps.defaultModel);
    expect(event.agent.tools?.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "dispatch",
      "mcp_search",
      "read",
      "weather_lookup",
    ]);
  });

  it("rejects a missing Resident model observably before agent construction", async () => {
    const operationalErrors: Array<{
      component: string;
      msg: string;
      error?: string;
      context?: Record<string, unknown>;
    }> = [];
    const unsubscribe = Bus.subscribe(Operational.Error, (payload) => {
      operationalErrors.push(payload);
    });
    const listTools = mock((): NativeTool[] => {
      throw new Error("tool selection must not run without a model");
    });
    const missingModelDeps = {
      ...deps,
      defaultModel: undefined,
      systemProvider: { listTools },
    };

    try {
      let thrown: unknown;
      try {
        buildResidentAgentDef(missingModelDeps);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BridgeAgentResolutionError);
      expect(thrown).toMatchObject({
        code: "missing_default_model",
        agentName: "resident",
        message: "Resident agent requires an explicitly resolved default model",
      });
      expect(listTools).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(operationalErrors).toHaveLength(1);
      expect(operationalErrors[0]).toMatchObject({
        component: "server",
        msg: "agent resolution failed",
        error: "missing_default_model",
        context: { code: "missing_default_model", agentName: "resident" },
      });
    } finally {
      unsubscribe();
    }
  });

  it("rejects an invalid explicit Resident model before agent construction", () => {
    let thrown: unknown;
    try {
      buildResidentAgentDef({
        ...deps,
        defaultModel: { provider: "anthropic", id: " " },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BridgeAgentResolutionError);
    expect(thrown).toMatchObject({
      code: "invalid_default_model",
      agentName: "resident",
      message: "Resident agent default model is invalid",
    });
  });

  it("discriminates a missing Resident model from an unknown agent", () => {
    let thrown: unknown;
    try {
      buildAgentDef("not-registered", deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BridgeAgentResolutionError);
    expect(thrown).toMatchObject({
      code: "unknown_agent",
      agentName: "not-registered",
      message: "Unknown agent definition: not-registered",
    });
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
