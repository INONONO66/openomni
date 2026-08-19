import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Channel, Ingress } from "@openomni/protocol";
import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createMessageHandler } from "../../src/handler/conversation";
import { completeWorkItem } from "../work-item-completion-fixture";

function makeMessage(text: string, surfaceKey = "ws:local-test"): Channel.InboundMessage {
  return {
    id: "message-1",
    traceId: "trace-test",
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
  return WorkItemStore.create(
    {
      name,
      sourceMessageId: `msg-${name.toLowerCase().replace(/\s+/g, "-")}`,
      sourceChannel: "discord",
      intent: "test",
      goal: `handle ${name}`,
      acceptanceCriteria: [`${name} is handled`],
      ...extra,
    },
    "trace-test",
  );
}

// The gateway router instance is the one handler dep (#549 discipline, #707
// home); ledger-command tests default to a fail-loud ingest that must never
// be reached. The old bridge deps (providers/model) moved behind bootstrap's
// external agent resolver and no longer touch the handler.
function handlerFor(ingest?: (event: unknown) => Promise<Ingress.IngressResult>) {
  return createMessageHandler({
    ingress: {
      ingest:
        ingest ??
        (async () => {
          throw new Error("ingress should not run for this message");
        }),
    },
  });
}

let completionWriter: Storage.WorkItemCompletionWriter;

beforeEach(() => {
  Storage.reset();
  completionWriter = Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Bus.reset();
  Storage.reset();
});

describe("conversation task ledger command", () => {
  it("returns an empty open task ledger when no work items are open", async () => {
    // Given
    const handler = handlerFor();

    // When
    const response = await handler(makeMessage(" show   open tasks "));

    // Then
    expect(response).toEqual({ text: "Open tasks: none" });
  });

  it("matches the open task command case-insensitively", async () => {
    // Given
    const handler = handlerFor();

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
    const handler = handlerFor(ingest);

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
    const handler = handlerFor(ingest);

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
    const handler = handlerFor(ingest);
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
    await WorkItemStore.start(running.workItemId, "trace-test");
    const runningEarlierByName = await createWorkItem("Audit feature", {
      intent: "audit",
      goal: "audit the feature",
    });
    await WorkItemStore.start(runningEarlierByName.workItemId, "trace-test");
    const blocked = await createWorkItem("Fix thing", {
      intent: "fix",
      goal: "fix the blocker",
      assigneeId: "worker-b",
      sessionId: "session-b",
    });
    await WorkItemStore.start(blocked.workItemId, "trace-test");
    await WorkItemStore.addBlocker(
      blocked.workItemId,
      {
        kind: "waiting_input",
        description: "needs owner input",
      },
      "trace-test",
    );
    const resolvedBlocker = await WorkItemStore.addBlocker(
      blocked.workItemId,
      {
        kind: "external",
        description: "already handled elsewhere",
      },
      "trace-test",
    );
    const resolvedBlockerId = resolvedBlocker?.blockers.at(-1)?.id;
    if (resolvedBlockerId)
      await WorkItemStore.resolveBlocker(blocked.workItemId, resolvedBlockerId, "trace-test");
    const completed = await createWorkItem("Done thing", {
      intent: "verify",
      goal: "verify complete items are hidden",
    });
    const completedResult = await completeWorkItem(completionWriter, completed.workItemId);
    const failed = await createWorkItem("Failed thing", {
      intent: "verify",
      goal: "verify failed items are hidden",
    });
    await WorkItemStore.fail(failed.workItemId, "trace-test", "not open");
    const cancelled = await createWorkItem("Cancelled thing", {
      intent: "verify",
      goal: "verify cancelled items are hidden",
    });
    await WorkItemStore.cancel(cancelled.workItemId, "trace-test");
    const handler = handlerFor();

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    expect(response).toEqual({
      text: [
        "Open tasks (4)",
        `- [blocked] Fix thing (hash: ${blocked.workItemId}, blockers: 1, assignee: worker-b, session: session-b)`,
        `- [pending] Plan rollout (hash: ${pending.workItemId}, assignee: worker-a, session: session-a)`,
        `- [running] Audit feature (hash: ${runningEarlierByName.workItemId})`,
        `- [running] Build feature (hash: ${running.workItemId})`,
      ].join("\n"),
    });
    expect(completedResult ? WorkItem.deriveStatus(completedResult) : undefined).toBe("completed");
  });

  it("caps long open task ledgers", async () => {
    // Given
    for (let i = 0; i < 21; i += 1) {
      await createWorkItem(`Task ${String(i).padStart(2, "0")}`);
    }
    const handler = handlerFor();

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
    const handler = handlerFor();

    // When
    const response = await handler(makeMessage("show open tasks"));

    // Then
    if (!response) throw new Error("expected task ledger response");
    const { text } = response;
    if (!text) throw new Error("expected task ledger text");
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toStartWith("Open tasks (1)\n");
    expect(text).toContain(`- [pending] Task with spoofed row ${"x".repeat(55)}...`);
    expect(text).toContain(`hash: ${item.workItemId}`);
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
    const handler = handlerFor(ingest);

    // When
    const response = await handler(makeMessage("show all tasks"));

    // Then
    expect(response).toEqual({ text: "ingress response" });
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
