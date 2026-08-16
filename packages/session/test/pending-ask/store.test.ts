import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Communication } from "@openomni/protocol";
import { PendingAskStore, Storage } from "../../src/index";
import { Bus } from "@openomni/telemetry";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

function frozenRecord(
  id: string,
  overrides: Partial<Communication.PendingAsk.Record> = {},
): Communication.PendingAsk.Record {
  return Communication.PendingAsk.Record.parse({
    id,
    originSessionId: "session-1",
    originActorKind: "worker",
    targetKind: "resident",
    status: "open",
    correlation: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

/**
 * Historical rows predate the #510 D2a freeze; tests emulate them at the
 * adapter layer because the store's write surface is frozen by design.
 */
function seedFrozenRow(record: Communication.PendingAsk.Record): void {
  const storage = Storage.getAdapter();
  const adapter = storage.pendingAsk;
  if (!adapter) throw new Error("pendingAsk adapter missing");
  // pending_ask.origin_session_id references session(id).
  storage.session.set(record.originSessionId, {
    id: record.originSessionId,
    title: record.originSessionId,
    model: { providerID: "test", modelID: "test" },
    time: { created: 1, updated: 1 },
    spawnDepth: 0,
  });
  adapter.create(record);
}

describe("PendingAskStore (frozen legacy writer, #510 D2a)", () => {
  test("every write method throws the typed frozen error and persists/publishes nothing", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    seedFrozenRow(frozenRecord("ask-frozen", { correlation: { threadId: "thread-1" } }));

    const attempts: ReadonlyArray<readonly [Communication.PendingAsk.WriteMethod, () => unknown]> =
      [
        [
          "create",
          () =>
            PendingAskStore.create({
              id: "ask-new",
              originSessionId: "session-1",
              originActorKind: "worker",
              targetKind: "resident",
              correlation: { externalMessageId: "m-new" },
            }),
        ],
        ["answer", () => PendingAskStore.answer("ask-frozen", { answeredAt: 10 })],
        ["markAmbiguous", () => PendingAskStore.markAmbiguous("ask-frozen")],
        ["cancel", () => PendingAskStore.cancel("ask-frozen")],
        ["expire", () => PendingAskStore.expire("ask-frozen")],
      ];

    for (const [method, attempt] of attempts) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      if (!Communication.PendingAsk.FrozenError.isInstance(thrown)) {
        throw new Error(`${method} did not throw the typed frozen error`);
      }
      expect(thrown.data.code).toBe("pending_ask_frozen");
      expect(thrown.data.method).toBe(method);
    }

    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toEqual([]);
    expect(PendingAskStore.get("ask-new")).toBeUndefined();
    expect(PendingAskStore.get("ask-frozen")?.status).toBe("open");
    expect(PendingAskStore.get("ask-frozen")?.updatedAt).toBe(1);
  });

  test("reads keep serving frozen rows exactly as persisted", () => {
    seedFrozenRow(
      frozenRecord("ask-open", { correlation: { externalMessageId: "m-1", threadId: "t-1" } }),
    );
    seedFrozenRow(
      frozenRecord("ask-ambiguous", { status: "ambiguous", correlation: { threadId: "t-1" } }),
    );
    seedFrozenRow(frozenRecord("ask-answered", { status: "answered", answeredAt: 10 }));

    expect(PendingAskStore.get("ask-answered")?.answeredAt).toBe(10);
    expect(PendingAskStore.list()).toHaveLength(3);
    expect(PendingAskStore.list(["open"])).toHaveLength(1);
    // Correlation lookup (the #519 upcast read path) still matches open AND
    // ambiguous frozen rows.
    expect(PendingAskStore.findByCorrelation({ threadId: "t-1" })).toHaveLength(2);
    expect(PendingAskStore.findByCorrelation({ externalMessageId: "m-1" })).toHaveLength(1);
  });

  test("frozen rows survive adapter recreation", () => {
    const adapter = Storage.getAdapter();
    seedFrozenRow(frozenRecord("ask-persisted", { correlation: { tokenHash: "token-3" } }));

    Storage.configure(adapter);

    expect(PendingAskStore.get("ask-persisted")?.status).toBe("open");
  });
});
