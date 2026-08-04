import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEngine, type NativeTool, type ToolProvider } from "@openomni/openomni";
import type { Adapter, Ingress, Tool } from "@openomni/protocol";
import { WorkItem } from "@openomni/protocol";
import { Bus, Storage, WorkItemStore } from "@openomni/session";
import { createCompletionAdmissionService } from "../../../../packages/openomni/src/work-item/completion-admission-boundary";
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
    acceptanceCriteria: [`${name} is handled`],
    ...extra,
  });
}

async function completeWorkItem(hash: string): Promise<WorkItem.Info | undefined> {
  const updated = await WorkItemStore.addEvidence(hash, {
    kind: "verification",
    description: "conversation ledger fixture evidence",
    passed: true,
  });
  const current = WorkItemStore.get(hash);
  const criterion = current?.completionFacts.criteria[0];
  const evidenceId = updated?.evidence.at(-1)?.id;
  if (!current || !criterion || !evidenceId) throw new Error("expected completion fixture");
  const request = WorkItem.CompletionRequest.parse({
    version: 1,
    id: `completion-request:${hash}:${current.revision}:conversation`,
    origin: "resident",
    workItemHash: hash,
    contractRevision: current.completionContract.revision,
    basisRef: current.completionContract.basisRef,
    expectedHead: current.revision,
    claims: [],
    observations: [],
    results: [
      {
        id: `result:${hash}:${current.revision}:conversation`,
        criterionId: criterion.id,
        value: "verified",
        checkedPredicate: criterion.statement,
        observationIds: [],
        verifierRef: "verifier:conversation",
        assumptions: [],
        basisRef: current.completionContract.basisRef,
        residualRisks: [],
        createdAt: current.timestamps.updated + 1,
      },
    ],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  });
  const report: WorkItem.CompletionReport = {
    summary: "Completed with fixture evidence.",
    claims: [{ statement: "The item is complete.", evidenceIds: [evidenceId] }],
    caveats: [],
    followUps: [],
  };
  const authorityResolver = {
    resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
      const item = WorkItem.Info.parse(itemInput);
      const candidate = WorkItem.CompletionRequest.parse(requestInput);
      return WorkItem.CompletionAdmission.parse({
        version: 1,
        id: `admission:${candidate.id}:${item.revision + 1}`,
        requestId: candidate.id,
        requestSnapshot: candidate,
        origin: candidate.origin,
        contractRevision: item.completionContract.revision,
        basisRef: item.completionContract.basisRef,
        effectiveResultIds: candidate.results.map(({ id }) => id),
        unresolvedCriterionIds: [],
        decision: "admit",
        reasonCodes: [],
        residualRisks: [],
        policyRef: "policy:conversation-test",
        expectedHead: item.revision,
        recordedHead: item.revision + 1,
        createdAt: item.timestamps.updated + 1,
      });
    },
  };
  const service = createCompletionAdmissionService({
    authorityResolver,
    now: () => current.timestamps.updated + 2,
  });
  await service.requestCompletion(request, report);
  return WorkItemStore.get(hash);
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
});
