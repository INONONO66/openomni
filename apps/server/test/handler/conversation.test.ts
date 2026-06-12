import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEngine, type NativeTool, type ToolProvider } from "@openomni/openomni";
import type { Adapter, Dispatch, Ingress, Tool } from "@openomni/protocol";
import { WorkItem } from "@openomni/protocol";
import {
  Bus,
  PendingInteractionStore,
  Session,
  Storage,
  WorkerRun,
  WorkItemStore,
} from "@openomni/session";
import { DiscordNormalizer } from "../../src/channel/discord/normalizer";
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

function makeMessage(text: string, surfaceKey = "ws:local-test"): Adapter.InboundMessage {
  return {
    id: "message-1",
    surfaceKey,
    text,
    sender: { id: "owner-1", name: "Owner" },
    raw: { websocket: { authenticated: true } },
  };
}

async function createWorkItem(
  name: string,
  extra?: Partial<Parameters<typeof WorkItemStore.create>[0]>,
) {
  return WorkItemStore.create({
    name,
    sourceMessageId: `msg-${name.toLowerCase().replace(/\s+/g, "-")}`,
    sourceChannel: "discord",
    intent: "test",
    goal: `handle ${name}`,
    ...extra,
  });
}

async function createPendingInteractionWorkerRun(runId: string): Promise<string> {
  const session = Session.create({
    title: `${runId}-session`,
    model: { providerID: "test", modelID: "test" },
  });
  await WorkerRun.create(session.id, { runId, title: runId, prompt: "test" });
  return session.id;
}

async function completeWorkItem(hash: string): Promise<WorkItem.Info | undefined> {
  const updated = await WorkItemStore.addEvidence(hash, {
    kind: "verification",
    description: "conversation ledger fixture evidence",
    passed: true,
  });
  const evidenceId = updated?.evidence.at(-1)?.id;
  if (!evidenceId) throw new Error("expected evidence id");
  return WorkItemStore.complete(hash, {
    summary: "Completed with fixture evidence.",
    claims: [{ statement: "The item is complete.", evidenceIds: [evidenceId] }],
    caveats: [],
    followUps: [],
  });
}

const deps: BridgeDeps = {
  systemProvider: makeProvider([makeTool("read")]),
  agentProvider: makeProvider([makeTool("dispatch")]),
  mcpProvider: makeProvider([]),
  customProvider: makeProvider([]),
  defaultModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  workspaceRoot: "/workspace",
};

const originalIngest = IngressEngine.ingest;

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  IngressEngine.ingest = originalIngest;
});

afterEach(() => {
  IngressEngine.ingest = originalIngest;
  Bus.reset();
  Storage.reset();
});

describe("conversation task ledger command", () => {
  it("returns an empty open task ledger when no work items are open", async () => {
    // Given
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage(" show   open tasks "));

    // Then
    expect(response).toEqual({ text: "Open tasks: none" });
  });

  it("matches the open task command case-insensitively", async () => {
    // Given
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("SHOW OPEN TASKS"));

    // Then
    expect(response).toEqual({ text: "Open tasks: none" });
  });

  it("bypasses ingress for the open task command", async () => {
    // Given
    const ingest = mock(async (): Promise<Ingress.IngressResult> => {
      throw new Error("ingress should not run for task ledger command");
    });
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    expect(response).toEqual({ text: "Open tasks: none" });
    expect(ingest).toHaveBeenCalledTimes(0);
  });

  it("rejects the open task command on external surfaces", async () => {
    // Given
    const ingest = mock(async (): Promise<Ingress.IngressResult> => {
      throw new Error("ingress should not run for unauthorized task ledger command");
    });
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show open tasks", "discord:guild:channel:dev"));

    // Then
    expect(response).toEqual({
      text: "Open task ledger requires authenticated local WebSocket access",
    });
    expect(ingest).toHaveBeenCalledTimes(0);
  });

  it("rejects the open task command on unauthenticated WebSocket messages", async () => {
    // Given
    const ingest = mock(async (): Promise<Ingress.IngressResult> => {
      throw new Error("ingress should not run for unauthenticated task ledger command");
    });
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);
    const message = makeMessage("show open tasks");

    // When
    const response = await handler({
      ...message,
      raw: { websocket: { authenticated: false } },
    });

    // Then
    expect(response).toEqual({
      text: "Open task ledger requires authenticated local WebSocket access",
    });
    expect(ingest).toHaveBeenCalledTimes(0);
  });

  it("returns a deterministic open task ledger when work items are open", async () => {
    // Given
    const pending = await createWorkItem("Plan rollout", {
      intent: "plan",
      goal: "create rollout plan",
      assigneeId: "worker-a",
      sessionId: "session-a",
    });
    const running = await createWorkItem("Build feature", {
      intent: "implement",
      goal: "build the feature",
    });
    await WorkItemStore.start(running.hash);
    const runningEarlierByName = await createWorkItem("Audit feature", {
      intent: "audit",
      goal: "audit the feature",
    });
    await WorkItemStore.start(runningEarlierByName.hash);
    const blocked = await createWorkItem("Fix thing", {
      intent: "fix",
      goal: "fix the blocker",
      assigneeId: "worker-b",
      sessionId: "session-b",
    });
    await WorkItemStore.start(blocked.hash);
    await WorkItemStore.addBlocker(blocked.hash, {
      kind: "waiting_input",
      description: "needs owner input",
    });
    const resolvedBlocker = await WorkItemStore.addBlocker(blocked.hash, {
      kind: "external",
      description: "already handled elsewhere",
    });
    const resolvedBlockerId = resolvedBlocker?.blockers.at(-1)?.id;
    if (resolvedBlockerId) await WorkItemStore.resolveBlocker(blocked.hash, resolvedBlockerId);
    const completed = await createWorkItem("Done thing", {
      intent: "verify",
      goal: "verify complete items are hidden",
    });
    const completedResult = await completeWorkItem(completed.hash);
    const failed = await createWorkItem("Failed thing", {
      intent: "verify",
      goal: "verify failed items are hidden",
    });
    await WorkItemStore.fail(failed.hash, "not open");
    const cancelled = await createWorkItem("Cancelled thing", {
      intent: "verify",
      goal: "verify cancelled items are hidden",
    });
    await WorkItemStore.cancel(cancelled.hash);
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    expect(response).toEqual({
      text: [
        "Open tasks (4)",
        `- [blocked] Fix thing (hash: ${blocked.hash}, blockers: 1, assignee: worker-b, session: session-b)`,
        `- [pending] Plan rollout (hash: ${pending.hash}, assignee: worker-a, session: session-a)`,
        `- [running] Audit feature (hash: ${runningEarlierByName.hash})`,
        `- [running] Build feature (hash: ${running.hash})`,
      ].join("\n"),
    });
    expect(completedResult ? WorkItem.deriveStatus(completedResult) : undefined).toBe("completed");
  });

  it("caps long open task ledgers", async () => {
    // Given
    for (let i = 0; i < 21; i += 1) {
      await createWorkItem(`Task ${String(i).padStart(2, "0")}`);
    }
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    if (!response) throw new Error("expected task ledger response");
    expect(response.text?.split("\n")).toHaveLength(22);
    expect(response.text).toStartWith("Open tasks (21)\n");
    expect(response.text).toContain("...and 1 more");
  });

  it("bounds rendered task fields to keep the ledger compact", async () => {
    // Given
    const longChunk = "x".repeat(160);
    const item = await createWorkItem(`Task\nwith spoofed row ${longChunk}`, {
      assigneeId: `worker\n${longChunk}`,
      sessionId: `session\t${longChunk}`,
    });
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    if (!response) throw new Error("expected task ledger response");
    const { text } = response;
    if (!text) throw new Error("expected task ledger text");
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toStartWith("Open tasks (1)\n");
    expect(text).toContain(`- [pending] Task with spoofed row ${"x".repeat(55)}...`);
    expect(text).toContain(`hash: ${item.hash}`);
    expect(text).toContain(`assignee: worker ${"x".repeat(70)}...`);
    expect(text).toContain(`session: session ${"x".repeat(69)}...`);
    expect(text.length).toBeLessThanOrEqual(320);
  });

  it("keeps non-command messages routed through ingress", async () => {
    // Given
    const ingest = mock(
      async (): Promise<Ingress.IngressResult> => ({
        mode: "direct",
        result: { output: "ingress response", finishReason: "stop" },
        sessionId: "session-1",
        target: { kind: "resident" },
      }),
    );
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler(deps);

    // When
    const response = await handler(makeMessage("show all tasks"));

    // Then
    expect(response).toEqual({ text: "ingress response" });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("wakes a PendingInteraction worker reply through dispatch before resident ingress", async () => {
    // Given
    const sessionId = await createPendingInteractionWorkerRun("run-pi-conversation");
    PendingInteractionStore.create({
      id: "pi-conversation-1",
      workerRunId: "run-pi-conversation",
      sessionId,
      endpointId: "bot-1",
      channelId: "dev",
      correlation: { replyToMessageId: "message-out-1" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });
    const normalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [] });
    const inbound = normalizer.normalize({
      id: "message-in-1",
      channel_id: "dev",
      guild_id: "guild-1",
      author: { id: "seller-1", username: "Seller" },
      content: "SN-A2334",
      message_reference: { message_id: "message-out-1" },
    });
    if (!inbound) throw new Error("expected normalized Discord reply");
    const ingest = mock(async (): Promise<Ingress.IngressResult> => {
      throw new Error("resident ingress should not run for PendingInteraction replies");
    });
    const dispatchCalls: Dispatch.Input[] = [];
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler({
      ...deps,
      dispatchRuntime: {
        submit: mock(async (input: Dispatch.Input) => {
          dispatchCalls.push(input);
          return {
            dispatchId: "dispatch-pi",
            status: "completed",
            output: { delivered: true },
            durationMs: 1,
          };
        }),
      },
    });

    // When
    const response = await handler(inbound);

    // Then
    expect(response).toBeNull();
    expect(ingest).toHaveBeenCalledTimes(0);
    expect(dispatchCalls).toEqual([
      {
        action: "actor.message",
        target: { kind: "surface", id: "discord:bot-1:channel:dev" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "bot-1",
          channelId: "dev",
          replyToMessageId: "message-out-1",
          externalConversationId: "discord:bot-1:channel:dev",
        },
      },
    ]);
  });

  it("falls back to resident ingress when no PendingInteraction matches", async () => {
    // Given
    const ingest = mock(
      async (): Promise<Ingress.IngressResult> => ({
        mode: "direct",
        result: { output: "resident response", finishReason: "stop" },
        sessionId: "session-1",
        target: { kind: "resident" },
      }),
    );
    IngressEngine.ingest = ingest;
    const dispatchSubmit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "dispatch-no-match",
        status: "denied",
        reason: "dispatch.actor.required",
        error: "dispatch.actor.required",
        durationMs: 1,
      }),
    );
    const handler = createMessageHandler({
      ...deps,
      dispatchRuntime: { submit: dispatchSubmit },
    });

    // When
    const response = await handler({
      ...makeMessage("hello", "discord:guild:channel:dev"),
      replyToId: "message-without-pi",
    });

    // Then
    expect(response).toEqual({ text: "resident response" });
    expect(dispatchSubmit).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("falls back to resident ingress when PendingInteraction matches are ambiguous", async () => {
    // Given
    const firstSessionId = await createPendingInteractionWorkerRun("run-pi-ambiguous-1");
    const secondSessionId = await createPendingInteractionWorkerRun("run-pi-ambiguous-2");
    for (const [id, sessionId, workerRunId] of [
      ["pi-ambiguous-1", firstSessionId, "run-pi-ambiguous-1"],
      ["pi-ambiguous-2", secondSessionId, "run-pi-ambiguous-2"],
    ] as const) {
      PendingInteractionStore.create({
        id,
        workerRunId,
        sessionId,
        endpointId: "guild",
        channelId: "dev",
        correlation: { replyToMessageId: "message-out-ambiguous" },
        allowedActions: ["report_result"],
        expiresAt: Date.now() + 60_000,
        followUpWindow: 60_000,
      });
    }
    const ingest = mock(
      async (): Promise<Ingress.IngressResult> => ({
        mode: "direct",
        result: { output: "resident handles ambiguity", finishReason: "stop" },
        sessionId: "session-1",
        target: { kind: "resident" },
      }),
    );
    const dispatchSubmit = mock(async () => {
      return {
        dispatchId: "dispatch-ambiguous",
        status: "denied",
        reason: "dispatch.actor.required",
        error: "dispatch.actor.required",
        durationMs: 1,
      } satisfies Dispatch.Result;
    });
    IngressEngine.ingest = ingest;
    const handler = createMessageHandler({
      ...deps,
      dispatchRuntime: { submit: dispatchSubmit },
    });

    // When
    const response = await handler({
      ...makeMessage("hello", "discord:guild:channel:dev"),
      replyToId: "message-out-ambiguous",
    });

    // Then
    expect(response).toEqual({ text: "resident handles ambiguity" });
    expect(dispatchSubmit).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
