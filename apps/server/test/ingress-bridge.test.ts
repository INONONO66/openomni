import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Adapter, Tool } from "@openomni/protocol";
import type { NativeTool, ToolProvider } from "@openomni/openomni";
import { PendingAskStore, Storage } from "@openomni/session";
import { agentMetadata, getAgentDefinition, registerAgent } from "../src/agents";
import { buildAgentDef, buildInboundEvent } from "../src/ingress/bridge";

function createSessionFixture(id: string): void {
  Storage.getAdapter().session.set(id, {
    id,
    title: id,
    model: { providerID: "test", modelID: "test" },
    time: { created: 1, updated: 1 },
    spawnDepth: 0,
  });
}

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

function makeWorkerHintedOwnerMessage(): Adapter.InboundMessage {
  return {
    ...makeMessage(),
    id: "message-worker-hint",
    text: "answer for that worker",
    replyToId: "worker-run-1",
    threadId: "worker-thread-1",
    raw: {
      target: { kind: "worker", sessionId: "worker-session-1", runId: "worker-run-1" },
      correlationToken: "worker-correlation-token",
    },
  };
}

const deps = {
  systemProvider: makeProvider([makeTool("read"), makeTool("bash")]),
  agentProvider: makeProvider([
    makeTool("subagent"),
    makeTool("dispatch"),
    makeTool("inbound_message"),
  ]),
  mcpProvider: makeProvider([makeTool("mcp_search")]),
  customProvider: makeProvider([makeTool("weather_lookup")]),
  defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  workspaceRoot: "/workspace",
};

describe("ingress bridge tool surfaces", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  it("uses Resident identity and tool selection with dispatch and without inbound_message", () => {
    const event = buildInboundEvent(makeMessage(), "dev", deps);

    expect(event.target).toEqual({ kind: "resident" });
    expect(event.meta?.agentName).toBe("resident");
    expect(event.agent.systemPrompt).toContain("Resident");
    expect(event.agent.tools?.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "dispatch",
      "mcp_search",
      "read",
      "subagent",
      "weather_lookup",
    ]);
  });

  it("maps owner inbound messages to Resident even when correlation hints mention a worker", () => {
    const event = buildInboundEvent(makeWorkerHintedOwnerMessage(), "dev", deps);

    expect(event.target).toEqual({ kind: "resident" });
    expect(event.meta?.target).toEqual({ kind: "resident" });
    expect(event.meta?.replyToId).toBe("worker-run-1");
    expect(event.meta?.threadId).toBe("worker-thread-1");
    expect(event.meta?.raw).toMatchObject({
      target: { kind: "worker", sessionId: "worker-session-1", runId: "worker-run-1" },
    });
  });

  it("attaches correlated PendingAsk state to owner replies for Resident mediation", () => {
    createSessionFixture("worker-session-1");
    PendingAskStore.create({
      id: "ask-1",
      originSessionId: "worker-session-1",
      originRunId: "worker-run-1",
      originActorKind: "worker",
      targetKind: "resident",
      endpointId: "guild",
      channelId: "dev",
      correlation: { tokenHash: "worker-correlation-token" },
    });

    const event = buildInboundEvent(makeWorkerHintedOwnerMessage(), "dev", deps);

    expect(event.target).toEqual({ kind: "resident" });
    expect(event.meta?.pendingAsk).toMatchObject({
      id: "ask-1",
      originSessionId: "worker-session-1",
      originRunId: "worker-run-1",
      originActorKind: "worker",
      targetKind: "resident",
      status: "open",
    });
  });

  it("marks conflicting PendingAsk reply hints as ambiguous instead of choosing the first match", () => {
    createSessionFixture("worker-session-token");
    createSessionFixture("worker-session-thread");
    PendingAskStore.create({
      id: "ask-token",
      originSessionId: "worker-session-token",
      originRunId: "run-token",
      originActorKind: "worker",
      targetKind: "resident",
      correlation: { tokenHash: "worker-correlation-token" },
    });
    PendingAskStore.create({
      id: "ask-thread",
      originSessionId: "worker-session-thread",
      originRunId: "run-thread",
      originActorKind: "worker",
      targetKind: "resident",
      endpointId: "guild",
      channelId: "dev",
      correlation: { threadId: "worker-thread-1" },
    });

    const event = buildInboundEvent(makeWorkerHintedOwnerMessage(), "dev", deps);

    expect(event.meta?.pendingAsk).toEqual({
      ids: ["ask-token", "ask-thread"],
      status: "ambiguous",
      ambiguous: true,
    });
    expect(PendingAskStore.get("ask-token")?.status).toBe("ambiguous");
    expect(PendingAskStore.get("ask-thread")?.status).toBe("ambiguous");
  });

  it("scopes weak PendingAsk reply hints by endpoint and channel", () => {
    createSessionFixture("other-session");
    createSessionFixture("current-session");
    PendingAskStore.create({
      id: "ask-other-channel",
      originSessionId: "other-session",
      originRunId: "other-run",
      originActorKind: "worker",
      targetKind: "resident",
      endpointId: "guild",
      channelId: "random",
      correlation: { threadId: "worker-thread-1" },
    });
    PendingAskStore.create({
      id: "ask-current-channel",
      originSessionId: "current-session",
      originRunId: "current-run",
      originActorKind: "worker",
      targetKind: "resident",
      endpointId: "guild",
      channelId: "dev",
      correlation: { threadId: "worker-thread-1" },
    });

    const event = buildInboundEvent(makeWorkerHintedOwnerMessage(), "dev", deps);

    expect(event.meta?.pendingAsk).toMatchObject({
      id: "ask-current-channel",
      originSessionId: "current-session",
      originRunId: "current-run",
      status: "open",
    });
    expect(PendingAskStore.get("ask-other-channel")?.status).toBe("open");
  });

  it("keeps full agent tool selection available for spawned workers", () => {
    const { customProvider: _customProvider, ...workerDeps } = deps;
    const workerAgent = buildAgentDef("dev", workerDeps);

    expect(workerAgent.tools?.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "dispatch",
      "read",
      "subagent",
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
