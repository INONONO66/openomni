import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus, PendingInteractionStore, Session, Storage, WorkerRun } from "../../src/index";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

async function createWorkerRun(runId: string): Promise<string> {
  const session = Session.create({
    title: `${runId}-session`,
    model: { providerID: "test", modelID: "test" },
  });
  await WorkerRun.create(session.id, { runId, title: runId, prompt: "test" });
  return session.id;
}

function createPendingInteraction(id: string, sessionId: string, expiresAt = 9_999_999_999_999) {
  return PendingInteractionStore.create({
    id,
    workerRunId: "run-1",
    sessionId,
    endpointId: "telegram:seller-1",
    channelId: "telegram:dm",
    correlation: {
      replyToMessageId: "reply-1",
      threadId: "thread-1",
      tokenHash: "token-1",
    },
    allowedActions: ["report_result", "ask_clarification"],
    expiresAt,
    followUpWindow: 100,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("PendingInteractionStore", () => {
  test("creates worker-owned routing state and finds it by scoped correlation", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    const sessionId = await createWorkerRun("run-1");

    const created = createPendingInteraction("pi-1", sessionId);

    expect(created.status).toBe("open");
    expect(
      PendingInteractionStore.findByCorrelation({
        endpointId: "telegram:seller-1",
        channelId: "telegram:dm",
        replyToMessageId: "reply-1",
      }),
    ).toHaveLength(1);
    expect(
      PendingInteractionStore.findByCorrelation({
        endpointId: "telegram:seller-1",
        channelId: "telegram:other",
        replyToMessageId: "reply-1",
      }),
    ).toHaveLength(0);

    await flushBus();
    expect(events).toContain("pending_interaction.opened");
  });

  test("keeps resolved interactions matchable only during the follow-up window", async () => {
    const sessionId = await createWorkerRun("run-1");
    createPendingInteraction("pi-2", sessionId);

    const resolved = PendingInteractionStore.resolve("pi-2", { resolvedAt: 20 });

    expect(resolved.status).toBe("resolved");
    expect(
      PendingInteractionStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          threadId: "thread-1",
        },
        119,
      ),
    ).toHaveLength(1);
    expect(
      PendingInteractionStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          threadId: "thread-1",
        },
        121,
      ),
    ).toHaveLength(0);
  });

  test("does not match follow-up records after the original follow-up window", async () => {
    const sessionId = await createWorkerRun("run-1");
    const resolvedAt = Date.now();
    createPendingInteraction("pi-follow-up", sessionId);
    PendingInteractionStore.resolve("pi-follow-up", { resolvedAt });
    PendingInteractionStore.markFollowUp("pi-follow-up");

    expect(
      PendingInteractionStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          threadId: "thread-1",
        },
        resolvedAt + 101,
      ),
    ).toHaveLength(0);
  });

  test("matches follow-up records inside the original follow-up window", async () => {
    const sessionId = await createWorkerRun("run-1");
    const resolvedAt = Date.now();
    createPendingInteraction("pi-follow-up-inside", sessionId);
    PendingInteractionStore.resolve("pi-follow-up-inside", { resolvedAt });
    PendingInteractionStore.markFollowUp("pi-follow-up-inside");

    expect(
      PendingInteractionStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          threadId: "thread-1",
        },
        resolvedAt + 100,
      ),
    ).toHaveLength(1);
  });

  test("does not match open interactions after expiresAt", async () => {
    const sessionId = await createWorkerRun("run-1");
    createPendingInteraction("pi-expired-open", sessionId, 1_000);

    expect(
      PendingInteractionStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          tokenHash: "token-1",
        },
        1_001,
      ),
    ).toHaveLength(0);
  });

  test("cleanupExpired expires stale open, resolved, and follow-up records", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    const cleanupAt = Date.now() + 101;
    const sessionId = await createWorkerRun("run-1");
    createPendingInteraction("pi-expired-open-cleanup", sessionId, cleanupAt - 1);
    createPendingInteraction("pi-active-open-cleanup", sessionId, cleanupAt + 1);
    createPendingInteraction("pi-expired-resolved-cleanup", sessionId);
    PendingInteractionStore.resolve("pi-expired-resolved-cleanup", { resolvedAt: cleanupAt - 101 });
    createPendingInteraction("pi-expired-follow-up-cleanup", sessionId);
    PendingInteractionStore.resolve("pi-expired-follow-up-cleanup", {
      resolvedAt: cleanupAt - 101,
    });
    PendingInteractionStore.markFollowUp("pi-expired-follow-up-cleanup");

    const expired = PendingInteractionStore.cleanupExpired(cleanupAt);
    await flushBus();

    expect(expired.map((record) => record.id).sort()).toEqual([
      "pi-expired-follow-up-cleanup",
      "pi-expired-open-cleanup",
      "pi-expired-resolved-cleanup",
    ]);
    expect(PendingInteractionStore.get("pi-expired-follow-up-cleanup")?.status).toBe("expired");
    expect(PendingInteractionStore.get("pi-expired-open-cleanup")?.status).toBe("expired");
    expect(PendingInteractionStore.get("pi-expired-resolved-cleanup")?.status).toBe("expired");
    expect(PendingInteractionStore.get("pi-active-open-cleanup")?.status).toBe("open");
    expect(events.filter((event) => event === "pending_interaction.expired")).toHaveLength(3);
  });

  test("terminal transitions are idempotent and stop correlation matches", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    const sessionId = await createWorkerRun("run-1");
    createPendingInteraction("pi-3", sessionId);

    const cancelled = PendingInteractionStore.cancel("pi-3", { cancelledAt: 10 });
    const duplicate = PendingInteractionStore.cancel("pi-3", { cancelledAt: 20 });
    await flushBus();

    expect(cancelled.status).toBe("cancelled");
    expect(duplicate.cancelledAt).toBe(10);
    expect(
      PendingInteractionStore.findByCorrelation({
        endpointId: "telegram:seller-1",
        channelId: "telegram:dm",
        tokenHash: "token-1",
      }),
    ).toHaveLength(0);
    expect(events.filter((event) => event === "pending_interaction.cancelled")).toHaveLength(1);
  });

  test("open interactions survive adapter recreation", async () => {
    const adapter = Storage.getAdapter();
    const sessionId = await createWorkerRun("run-1");
    createPendingInteraction("pi-4", sessionId);

    Storage.configure(adapter);

    expect(PendingInteractionStore.get("pi-4")?.status).toBe("open");
  });
});
