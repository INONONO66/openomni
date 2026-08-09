import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Communication } from "@openomni/protocol";
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

function frozenRecord(
  id: string,
  sessionId: string,
  overrides: Partial<Communication.PendingInteraction.Record> = {},
): Communication.PendingInteraction.Record {
  return Communication.PendingInteraction.Record.parse({
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
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 9_999_999_999_999,
    followUpWindow: 100,
    ...overrides,
  });
}

/**
 * Historical rows predate the #548 freeze; tests emulate them at the adapter
 * layer because the store's write surface is frozen by design (pending-ask
 * precedent, #510 D2a).
 */
function seedFrozenRow(record: Communication.PendingInteraction.Record): void {
  const adapter = Storage.getAdapter().pendingInteraction;
  if (!adapter) throw new Error("pendingInteraction adapter missing");
  adapter.create(record);
}

describe("PendingInteractionStore (frozen legacy writer, #548)", () => {
  test("every write method throws the typed frozen error and persists/publishes nothing", async () => {
    const sessionId = await createWorkerRun("run-1");
    seedFrozenRow(frozenRecord("pi-frozen", sessionId));
    await flushBus();
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    const attempts: ReadonlyArray<
      readonly [Communication.PendingInteraction.WriteMethod, () => unknown]
    > = [
      [
        "create",
        () =>
          PendingInteractionStore.create({
            id: "pi-new",
            workerRunId: "run-1",
            sessionId,
            endpointId: "telegram:seller-1",
            channelId: "telegram:dm",
            correlation: { replyToMessageId: "reply-new" },
            allowedActions: ["report_result"],
            expiresAt: Date.now() + 60_000,
            followUpWindow: 100,
          }),
      ],
      ["resolve", () => PendingInteractionStore.resolve("pi-frozen", { resolvedAt: 10 })],
      ["markFollowUp", () => PendingInteractionStore.markFollowUp("pi-frozen")],
      ["cancel", () => PendingInteractionStore.cancel("pi-frozen", { cancelledAt: 10 })],
      ["cleanupExpired", () => PendingInteractionStore.cleanupExpired()],
    ];

    for (const [method, attempt] of attempts) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      if (!Communication.PendingInteraction.FrozenError.isInstance(thrown)) {
        throw new Error(`expected the typed PendingInteractionFrozenError for ${method}`);
      }
      expect(thrown.data.code).toBe("pending_interaction_frozen");
      expect(thrown.data.method).toBe(method);
    }

    await flushBus();
    expect(events).toEqual([]);
    // The frozen row is untouched; the rejected create persisted nothing.
    expect(PendingInteractionStore.get("pi-frozen")).toEqual(frozenRecord("pi-frozen", sessionId));
    expect(PendingInteractionStore.get("pi-new")).toBeUndefined();
  });

  test("frozen rows stay readable by id and by scoped correlation", async () => {
    const sessionId = await createWorkerRun("run-1");
    seedFrozenRow(frozenRecord("pi-read", sessionId));

    expect(PendingInteractionStore.get("pi-read")?.status).toBe("open");
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
  });

  test("read-time expiry gates frozen open rows past expiresAt", async () => {
    const sessionId = await createWorkerRun("run-1");
    seedFrozenRow(frozenRecord("pi-expired-open", sessionId, { expiresAt: 1_000 }));

    const query = {
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      tokenHash: "token-1",
    };
    expect(PendingInteractionStore.findByCorrelation(query, 999)).toHaveLength(1);
    expect(PendingInteractionStore.findByCorrelation(query, 1_001)).toHaveLength(0);
  });

  test("read-time expiry keeps resolved rows matchable only during the follow-up window", async () => {
    const sessionId = await createWorkerRun("run-1");
    seedFrozenRow(
      frozenRecord("pi-resolved", sessionId, {
        status: "resolved",
        resolvedAt: 20,
      }),
    );

    const query = {
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      threadId: "thread-1",
    };
    expect(PendingInteractionStore.findByCorrelation(query, 119)).toHaveLength(1);
    expect(PendingInteractionStore.findByCorrelation(query, 121)).toHaveLength(0);
  });

  test("read-time expiry gates follow-up rows by the original follow-up window", async () => {
    const sessionId = await createWorkerRun("run-1");
    seedFrozenRow(
      frozenRecord("pi-follow-up", sessionId, {
        status: "follow_up",
        resolvedAt: 20,
      }),
    );

    const query = {
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      threadId: "thread-1",
    };
    expect(PendingInteractionStore.findByCorrelation(query, 120)).toHaveLength(1);
    expect(PendingInteractionStore.findByCorrelation(query, 121)).toHaveLength(0);
  });

  test("frozen rows survive adapter recreation", async () => {
    const adapter = Storage.getAdapter();
    const sessionId = await createWorkerRun("run-1");
    seedFrozenRow(frozenRecord("pi-survive", sessionId));

    Storage.configure(adapter);

    expect(PendingInteractionStore.get("pi-survive")?.status).toBe("open");
  });
});
