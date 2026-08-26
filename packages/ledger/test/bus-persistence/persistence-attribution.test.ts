import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { Session } from "../../src/session/index.js";
import { Storage } from "../../src/storage/storage.js";
import { WaitStore } from "../../src/wait/index.js";
import { buildWaitCreate } from "../helpers/wait.js";
import "../../src/storage/initialize.js";

interface BusEventRow {
  readonly session_id: string | null;
  readonly event_type: string;
  readonly trace_id: string;
}

function db(): Database {
  const descriptor = Object.getOwnPropertyDescriptor(Storage.getAdapter(), "db");
  if (descriptor?.value instanceof Database) return descriptor.value;
  throw new Error("Expected SQLite-backed storage adapter");
}

function rows(eventType: string): BusEventRow[] {
  return db()
    .query("SELECT session_id, event_type, trace_id FROM bus_event WHERE event_type = ?")
    .all(eventType) as BusEventRow[];
}

async function flushPersistence(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("persistence attribution refuses to launder foreign ids", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    BusPersistence.start();
  });

  afterEach(() => {
    BusPersistence.stop();
    Storage.reset();
    Bus.reset();
  });

  test("wait events persist on the sessionless chain — a waitId is not a sessionId", async () => {
    // The old root-level `id` attribution stamped session_id = waitId, which
    // FK-failed against the session table and silently DROPPED every wait.*
    // row. Wait events carry no session; they belong to the sessionless chain.
    WaitStore.create(buildWaitCreate(), "trace-wait-persist");
    await flushPersistence();

    expect(rows("wait.opened")).toEqual([
      { session_id: null, event_type: "wait.opened", trace_id: "trace-wait-persist" },
    ]);
  });

  test("session.deleted persists after the row is gone — sessionless by design", async () => {
    // Publishing after adapter removal means a session-attributed row can
    // never satisfy the FK: the deletion event must outlive its session on
    // the sessionless chain (the CASCADE-purge survivor the chain exists for).
    const session = Session.create({
      traceId: "trace-delete-persist",
      title: "Doomed",
      model: { providerID: "test", modelID: "test-model" },
    });
    await flushPersistence();
    // While the session lives, its created row is session-attributed.
    expect(rows("session.created")).toEqual([
      { session_id: session.id, event_type: "session.created", trace_id: "trace-delete-persist" },
    ]);

    Session.remove(session.id, "trace-delete-persist");
    await flushPersistence();

    expect(rows("session.deleted")).toEqual([
      { session_id: null, event_type: "session.deleted", trace_id: "trace-delete-persist" },
    ]);
    // The created row CASCADE-purges with its session BY DESIGN; the
    // sessionless deleted row and the event_chain hashes are the survivors.
    expect(rows("session.created")).toEqual([]);
    const chain = db().query("SELECT event_type FROM event_chain ORDER BY seq ASC").all() as Array<{
      event_type: string;
    }>;
    expect(chain.map((row) => row.event_type)).toContain("session.created");
    expect(chain.map((row) => row.event_type)).toContain("session.deleted");
  });

});

describe("persistence failure is loud and contained", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    BusPersistence.stop();
    Storage.reset();
    Bus.reset();
  });

  test("a poison row drops alone: batch-mates persist, the drop warns and counts", async () => {
    // Force one FK-violating row inside a multi-row batch: the resolver
    // stamps a nonexistent session id onto exactly one event type.
    BusPersistence.start({
      resolveSessionId: (event) =>
        event.name === "session.created" ? "session-that-does-not-exist" : undefined,
    });
    const warns: Array<Record<string, unknown>> = [];
    Bus.subscribe(Operational.Events.Warn, (payload) => {
      warns.push(payload as unknown as Record<string, unknown>);
    });
    const dropsBefore = BusPersistence.stats().droppedEventCount;

    // Same microtask turn — both publishes land in ONE writer batch.
    Session.create({
      traceId: "trace-poison",
      title: "Poison batch",
      model: { providerID: "test", modelID: "test-model" },
    });
    WaitStore.create(buildWaitCreate({ id: "wait-poison" }), "trace-poison");
    await flushPersistence();
    await flushPersistence();

    // The poison row (session.created → bogus FK) is gone; its batch-mate
    // survived the per-row retry.
    expect(rows("session.created")).toEqual([]);
    expect(rows("wait.opened")).toHaveLength(1);

    // The drop is LOUD: counter incremented and one Operational.Events.Warn
    // published (which itself persists as a bus event).
    expect(BusPersistence.stats().droppedEventCount).toBe(dropsBefore + 1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      component: "bus-persistence",
      msg: "bus event dropped from persistence: session.created",
    });
    expect(rows("operational.warn")).toHaveLength(1);
  });

  test("the drop-warning survives the FK-dead sessionId that caused the drop (default resolver)", async () => {
    // The dominant production drop class: a payload sessionId whose session
    // row is gone at persist time. The DEFAULT resolver reads payload
    // sessionId first, so if the drop-warning re-stamped the same poison id
    // at its root, the warn itself would FK-fail and the recursion guard
    // would degrade the "audit trail records its own gap" claim to a console
    // whisper. Pin: the warn rides the sessionless chain and persists.
    BusPersistence.start();
    const warns: Array<Record<string, unknown>> = [];
    Bus.subscribe(Operational.Events.Warn, (payload) => {
      warns.push(payload as unknown as Record<string, unknown>);
    });
    const dropsBefore = BusPersistence.stats().droppedEventCount;

    Bus.publish(Operational.Events.Warn, {
      traceId: "trace-fk-dead",
      time: Date.now(),
      sessionId: "session-that-does-not-exist",
      component: "test-producer",
      msg: "poison warn",
    });
    await flushPersistence();
    await flushPersistence();

    // Exactly ONE logical drop: the poison warn. The self-warn persisted, so
    // it must not have re-entered the drop path (no double count).
    expect(BusPersistence.stats().droppedEventCount).toBe(dropsBefore + 1);
    const selfWarn = warns.find((w) => w.component === "bus-persistence");
    if (selfWarn === undefined) throw new Error("no drop-warning published");
    expect(selfWarn.sessionId).toBeUndefined();
    expect((selfWarn.context as { droppedSessionId?: string }).droppedSessionId).toBe(
      "session-that-does-not-exist",
    );
    expect(rows("operational.warn")).toEqual([
      { session_id: null, event_type: "operational.warn", trace_id: "trace-fk-dead" },
    ]);
  });
});
