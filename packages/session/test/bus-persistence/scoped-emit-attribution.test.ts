import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Operational } from "@openomni/protocol";
import { Bus, busSinkForTest, scope } from "./scoped-emit-fixture.js";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { Session } from "../../src/session/index.js";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

/**
 * A scoped emitter attaches its identity to every payload it publishes, which
 * has consequences in the journal that differ per field:
 *
 *   - `sessionId` IS declared on `Operational`'s `LogBase`, so it survives
 *     `parsePayload` and `defaultResolveSessionId` attributes the row to that
 *     session — moving it out of the `session_id IS NULL` hash chain into the
 *     session's own.
 *   - `runId` / `actorId` / `agentName` are NOT declared, so zod strips them
 *     and `run_id` is written NULL even though the emitter knew the value.
 *     Populating it requires the descriptor to declare the field; the emitter
 *     cannot smuggle it past the schema.
 *   - A `sessionId` with no matching session row fails the `bus_event` foreign
 *     key, and the write is dropped with a warning rather than raised.
 *
 * Only descriptors that reach the journal are affected: `Operational.Debug`
 * and `Operational.Info` are `ephemeral` and never persist. The agent core's
 * budget and retry reporting uses `Warn`, which does.
 *
 * Nothing emits through `scope()` in production yet. This pins the
 * consequences now, so the driver conversion (#606 Phase 1b) has to confront
 * them instead of changing ledger attribution silently.
 */
interface BusEventRow {
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly trace_id: string;
  readonly event_type: string;
}

function db(): Database {
  return (Storage.getAdapter() as unknown as { readonly db: Database }).db;
}

function rows(): BusEventRow[] {
  return db()
    .query("SELECT session_id, run_id, trace_id, event_type FROM bus_event ORDER BY id ASC")
    .all() as BusEventRow[];
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => queueMicrotask(resolve));
    await BusPersistence.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("scoped emit attribution", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    BusPersistence.stop();
    Bus.reset();
    Storage.reset();
  });

  test("declared identity is attributed; undeclared identity is dropped", async () => {
    const session = Session.create({
      title: "scoped emit",
      model: { providerID: "test", modelID: "test-model" },
    });
    BusPersistence.start();

    const log = scope(
      { traceId: "trace-attr", sessionId: session.id, runId: "run-attr", actorId: "actor" },
      busSinkForTest(),
    );

    log.emit(Operational.Warn, { component: "test", msg: "persisted" });
    // Ephemeral descriptors never reach the journal, so they cannot re-bucket.
    log.emit(Operational.Info, { component: "test", msg: "ephemeral" });
    await settle();

    const persisted = rows().filter((row) => row.event_type.startsWith("operational."));
    expect(persisted.map((row) => row.event_type)).toEqual([Operational.Warn.name]);
    expect(persisted[0]?.trace_id).toBe("trace-attr");
    expect(persisted[0]?.session_id).toBe(session.id);
    expect(persisted[0]?.run_id).toBeNull();
  });

  test("a session id with no session row drops the write instead of raising", async () => {
    BusPersistence.start();

    const log = scope(
      { traceId: "trace-orphan", sessionId: "session-that-does-not-exist", runId: "run-orphan" },
      busSinkForTest(),
    );

    expect(() => log.emit(Operational.Warn, { component: "test", msg: "orphan" })).not.toThrow();
    await settle();

    expect(rows().filter((row) => row.trace_id === "trace-orphan")).toHaveLength(0);
  });
});
