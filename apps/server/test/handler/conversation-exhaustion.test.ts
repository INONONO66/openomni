import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NativeTool, ToolProvider } from "@openomni/openomni";
import type { Adapter, Tool } from "@openomni/protocol";
import { Bus, Storage, WorkItemStore } from "@openomni/session";
import { createMessageHandler } from "../../src/handler/conversation";
import type { BridgeDeps } from "../../src/ingress/bridge";

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

function makeProvider(tools: readonly NativeTool[]): ToolProvider {
  return {
    name: "provider",
    category: "system",
    listTools: () => [...tools],
    execute: mock(async (call: Tool.Call) => ({
      id: call.id,
      toolCallId: call.id,
      output: "result",
    })),
  };
}

function makeMessage(text: string): Adapter.InboundMessage {
  return {
    id: "message-1",
    traceId: "trace-test",
    surfaceKey: "ws:local-test",
    text,
    sender: { id: "owner-1", name: "Owner" },
    raw: { websocket: { authenticated: true } },
  };
}

const bridgeDeps: BridgeDeps = {
  systemProvider: makeProvider([makeTool("read")]),
  agentProvider: makeProvider([makeTool("dispatch")]),
  mcpProvider: makeProvider([]),
  customProvider: makeProvider([]),
  defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  workspaceRoot: "/workspace",
};

// Ledger commands never reach kernel ingress; the injected instance (#549)
// fails loudly if they do.
const deps = {
  ...bridgeDeps,
  ingress: {
    ingest: async (): Promise<never> => {
      throw new Error("ingress should not run for task ledger command");
    },
  },
};

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

describe("conversation task ledger exhaustion escalations", () => {
  it("shows retry-exhausted failed work items to the Owner", async () => {
    // Given
    const item = await WorkItemStore.create({
      name: "Retry exhausted worker",
      sourceMessageId: "msg-retry-exhausted",
      sourceChannel: "dispatch",
      intent: "worker.spawn",
      goal: "complete the exhausted task",
      acceptanceCriteria: ["the exhausted task is complete"],
      maxAttempts: 1,
    });
    await WorkItemStore.fail(item.hash, "permanent failure");
    let thrown: unknown;
    try {
      await WorkItemStore.retry(item.hash);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) throw new Error("expected retry exhaustion error");
    expect(thrown.message).toContain("retry attempts exhausted for work item");
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    expect(response).toEqual({
      text: [
        "Open tasks (1)",
        `- [failed] Retry exhausted worker (hash: ${item.hash}, blockers: 1, attempts: 1/1)`,
      ].join("\n"),
    });
  });

  it("hides failed work items without an active retry-exhaustion blocker", async () => {
    // Given
    const ordinaryFailed = await WorkItemStore.create({
      name: "Ordinary failed worker",
      sourceMessageId: "msg-ordinary-failed",
      sourceChannel: "dispatch",
      intent: "worker.spawn",
      goal: "complete the ordinary failed task",
      acceptanceCriteria: ["the ordinary failed task is complete"],
    });
    await WorkItemStore.fail(ordinaryFailed.hash, "non-retry failure");

    const resolvedExhaustion = await WorkItemStore.create({
      name: "Resolved exhausted worker",
      sourceMessageId: "msg-resolved-exhausted",
      sourceChannel: "dispatch",
      intent: "worker.spawn",
      goal: "complete the resolved exhausted task",
      acceptanceCriteria: ["the resolved exhausted task is complete"],
      maxAttempts: 1,
    });
    await WorkItemStore.fail(resolvedExhaustion.hash, "permanent failure");
    let thrown: unknown;
    try {
      await WorkItemStore.retry(resolvedExhaustion.hash);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) throw new Error("expected retry exhaustion error");
    const exhausted = WorkItemStore.get(resolvedExhaustion.hash);
    const blockerId = exhausted?.blockers.at(-1)?.id;
    if (!blockerId) throw new Error("expected retry exhaustion blocker");
    await WorkItemStore.resolveBlocker(resolvedExhaustion.hash, blockerId);

    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    expect(response).toEqual({ text: "Open tasks: none" });
  });
});
