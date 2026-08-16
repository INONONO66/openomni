import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
