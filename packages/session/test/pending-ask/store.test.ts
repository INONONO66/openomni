import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus, PendingAskStore, Storage } from "../../src/index";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

const flushBus = () => new Promise((resolve) => queueMicrotask(resolve));
function createSessionFixture(id: string): void {
  Storage.getAdapter().session.set(id, {
    id,
    title: id,
    model: { providerID: "test", modelID: "test" },
    time: { created: 1, updated: 1 },
    spawnDepth: 0,
  });
}

describe("PendingAskStore", () => {
  test("creates, finds by correlation, and answers once", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    createSessionFixture("session-1");
    PendingAskStore.create({
      id: "ask-1",
      originSessionId: "session-1",
      originActorKind: "worker",
      targetKind: "resident",
      correlation: { externalMessageId: "m-1", threadId: "t-1" },
    });

    expect(PendingAskStore.findByCorrelation({ externalMessageId: "m-1" })).toHaveLength(1);

    const answered = PendingAskStore.answer("ask-1", { answeredAt: 10 });
    expect(answered.status).toBe("answered");
    expect(answered.answeredAt).toBe(10);

    const duplicate = PendingAskStore.answer("ask-1", { answeredAt: 20 });
    await flushBus();

    expect(duplicate.answeredAt).toBe(10);
    expect(events.filter((event) => event === "pending_ask.answered")).toHaveLength(1);
  });

  test("keeps ambiguous non-terminal until cancelled or expired", () => {
    createSessionFixture("session-1");
    PendingAskStore.create({
      id: "ask-2",
      originSessionId: "session-1",
      originActorKind: "worker",
      targetKind: "external_actor",
      correlation: { threadId: "thread-1" },
    });

    expect(PendingAskStore.markAmbiguous("ask-2").status).toBe("ambiguous");
    expect(PendingAskStore.findByCorrelation({ threadId: "thread-1" })).toHaveLength(1);
    expect(PendingAskStore.cancel("ask-2").status).toBe("cancelled");
  });

  test("open asks survive adapter recreation", () => {
    const adapter = Storage.getAdapter();
    createSessionFixture("session-1");
    PendingAskStore.create({
      id: "ask-3",
      originSessionId: "session-1",
      originActorKind: "worker",
      targetKind: "resident",
      correlation: { tokenHash: "token-3" },
    });

    Storage.configure(adapter);

    expect(PendingAskStore.get("ask-3")?.status).toBe("open");
  });
});
