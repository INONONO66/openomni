import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { BusEvent } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { BusQuery } from "../../src/bus-persistence/query.js";
import { GENESIS_SEED, computeEventHash } from "../../src/bus-persistence/hash.js";
import { Session } from "../../src/session/index.js";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

interface BusEventRow {
  readonly id: number;
  readonly session_id: string | null;
  readonly event_type: string;
  readonly data: string;
  readonly trace_id: string;
  readonly time_created: number;
  readonly prev_hash: string | null;
  readonly event_hash: string | null;
}

interface EventChainRow {
  readonly seq: number;
  readonly session_id: string | null;
  readonly event_type: string;
  readonly event_hash: string;
  readonly prev_hash: string;
  readonly time_created: number;
}

function db(): Database {
  return (Storage.get() as unknown as { readonly db: Database }).db;
}

function busRows(sessionId?: string): BusEventRow[] {
  if (sessionId) {
    return db()
      .query("SELECT * FROM bus_event WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as BusEventRow[];
  }
  return db().query("SELECT * FROM bus_event ORDER BY id ASC").all() as BusEventRow[];
}

function chainRows(sessionId?: string): EventChainRow[] {
  if (sessionId) {
    return db()
      .query("SELECT * FROM event_chain WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as EventChainRow[];
  }
  return db().query("SELECT * FROM event_chain ORDER BY seq ASC").all() as EventChainRow[];
}

/**
 * `BusPersistence.flush()` is the exact quiescence barrier: it returns only on
 * a turn that commits nothing with no writes in flight
 * (`src/bus-persistence/runtime-state.ts:128-143`), which
 * `flush-barrier.test.ts:50-57` pins. A shortfall after it is a real
 * persistence defect, so this throws with the observed count instead of
 * handing back a short array — several call sites discard the return value and
 * would otherwise assert against a chain the writer never finished.
 */
async function persistedRows(expectedCount: number): Promise<BusEventRow[]> {
  await BusPersistence.flush();
  const current = busRows();
  if (current.length < expectedCount) {
    throw new Error(
      `persistence barrier resolved with ${current.length} rows, expected at least ${expectedCount}`,
    );
  }
  return current;
}

function createSession(): ReturnType<typeof Session.create> {
  return Session.create({
    traceId: "trace-hash-chain",
    title: "hash chain test",
    model: { providerID: "test", modelID: "test-model" },
  });
}

const testEvent = BusEvent.define(
  "test.hash.event",
  z.object({
    sessionId: z.string(),
    traceId: z.string(),
    time: z.number(),
    index: z.number(),
  }),
);

describe("Hash Chain", () => {
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

  test("persisted events include prev_hash and event_hash", async () => {
    const session = createSession();
    BusPersistence.start();

    Bus.publish(testEvent, {
      sessionId: session.id,
      traceId: "trace-1",
      time: 1000,
      index: 0,
    });

    const rows = await persistedRows(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prev_hash).toBe(GENESIS_SEED);
    expect(rows[0]?.event_hash).toBeString();
    expect(rows[0]?.event_hash).toHaveLength(64);
  });

  test("hash chain links consecutive events", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 3; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-${i}`,
        time: 1000 + i,
        index: i,
      });
    }

    const rows = await persistedRows(3);
    expect(rows).toHaveLength(3);

    const [row0, row1, row2] = rows;
    if (row0 === undefined || row1 === undefined || row2 === undefined) {
      throw new Error("shape");
    }
    expect(row0.prev_hash).toBe(GENESIS_SEED);
    expect(row1.prev_hash).toBe(row0.event_hash);
    expect(row2.prev_hash).toBe(row1.event_hash);
  });

  test("event_chain audit table mirrors bus_event hashes", async () => {
    const session = createSession();
    BusPersistence.start();

    Bus.publish(testEvent, {
      sessionId: session.id,
      traceId: "trace-audit",
      time: 2000,
      index: 0,
    });

    await persistedRows(1);
    const chain = chainRows(session.id);
    const events = busRows(session.id);

    expect(chain).toHaveLength(1);
    const chainHead = chain[0];
    const eventHead = events[0];
    if (chainHead === undefined || eventHead === undefined) throw new Error("shape");
    if (eventHead.event_hash === null || eventHead.prev_hash === null) {
      throw new Error("shape");
    }
    expect(chainHead.event_hash).toBe(eventHead.event_hash);
    expect(chainHead.prev_hash).toBe(eventHead.prev_hash);
    expect(chainHead.event_type).toBe("test.hash.event");
    expect(chainHead.session_id).toBe(session.id);
  });

  test("verifyChainIntegrity reports valid for untampered chain", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 5; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-${i}`,
        time: 3000 + i,
        index: i,
      });
    }

    await persistedRows(5);
    const result = await BusQuery.verifyChainIntegrity(session.id);

    expect(result.valid).toBe(true);
    expect(result.totalVerified).toBe(5);
    expect(result.brokenAtId).toBeUndefined();
  });

  test("verifyChainIntegrity does not count rows without hashes as verified", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 3; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-unhashed-${i}`,
        time: 3500 + i,
        index: i,
      });
    }

    await persistedRows(3);
    const rows = busRows(session.id);
    BusPersistence.stop();
    const firstRow = rows[0];
    const historicalRow = rows[1];
    const followingRow = rows[2];
    if (
      firstRow === undefined ||
      historicalRow === undefined ||
      followingRow === undefined ||
      firstRow.event_hash === null
    ) {
      throw new Error("shape");
    }

    db()
      .query("UPDATE bus_event SET prev_hash = NULL, event_hash = NULL WHERE id = ?")
      .run(historicalRow.id);
    const followingHash = computeEventHash({
      prevHash: firstRow.event_hash,
      eventType: followingRow.event_type,
      data: followingRow.data,
      traceId: followingRow.trace_id,
      timeCreated: followingRow.time_created,
    });
    db()
      .query("UPDATE bus_event SET prev_hash = ?, event_hash = ? WHERE id = ?")
      .run(firstRow.event_hash, followingHash, followingRow.id);

    const result = await BusQuery.verifyChainIntegrity(session.id);

    expect(result.valid).toBe(true);
    expect(result.totalVerified).toBe(2);
  });

  test("verifyChainIntegrity walks the sessionless chain when no session is given", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 2; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-sessionless-${i}`,
        time: 3700 + i,
        index: i,
      });
    }

    await persistedRows(2);
    BusPersistence.stop();
    // session_id is not part of the hash input, so detaching the rows from
    // the session moves them onto the sessionless chain without breaking it.
    db().query("UPDATE bus_event SET session_id = NULL").run();

    const result = await BusQuery.verifyChainIntegrity();

    expect(result.valid).toBe(true);
    expect(result.totalVerified).toBe(2);
  });

  test("verifyChainIntegrity detects tampered event_hash", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 3; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-${i}`,
        time: 4000 + i,
        index: i,
      });
    }

    await persistedRows(3);
    const rows = busRows(session.id);
    const tamperedRow = rows[1];
    if (tamperedRow === undefined) throw new Error("shape");

    db()
      .query("UPDATE bus_event SET event_hash = ? WHERE id = ?")
      .run("deadbeef".repeat(8), tamperedRow.id);

    const result = await BusQuery.verifyChainIntegrity(session.id);

    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(tamperedRow.id);
  });

  test("verifyChainIntegrity detects tampered data", async () => {
    const session = createSession();
    BusPersistence.start();

    Bus.publish(testEvent, {
      sessionId: session.id,
      traceId: "trace-tamper",
      time: 5000,
      index: 0,
    });

    await persistedRows(1);
    const rows = busRows(session.id);
    const tamperedRow = rows[0];
    if (tamperedRow === undefined) throw new Error("shape");

    db()
      .query("UPDATE bus_event SET data = ? WHERE id = ?")
      .run('{"tampered":true}', tamperedRow.id);

    const result = await BusQuery.verifyChainIntegrity(session.id);

    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(tamperedRow.id);
  });

  test("verifyChainIntegrity detects broken prev_hash link", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 3; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-${i}`,
        time: 6000 + i,
        index: i,
      });
    }

    await persistedRows(3);
    const rows = busRows(session.id);
    const tamperedRow = rows[2];
    if (tamperedRow === undefined) throw new Error("shape");

    db()
      .query("UPDATE bus_event SET prev_hash = ? WHERE id = ?")
      .run("wrong_prev_hash", tamperedRow.id);

    const result = await BusQuery.verifyChainIntegrity(session.id);

    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(tamperedRow.id);
  });

  test("session-scoped chains are independent", async () => {
    const sessionA = createSession();
    const sessionB = createSession();
    BusPersistence.start();

    Bus.publish(testEvent, {
      sessionId: sessionA.id,
      traceId: "trace-a",
      time: 7000,
      index: 0,
    });
    Bus.publish(testEvent, {
      sessionId: sessionB.id,
      traceId: "trace-b",
      time: 7001,
      index: 0,
    });

    await persistedRows(2);
    const rowsA = busRows(sessionA.id);
    const rowsB = busRows(sessionB.id);

    expect(rowsA[0]?.prev_hash).toBe(GENESIS_SEED);
    expect(rowsB[0]?.prev_hash).toBe(GENESIS_SEED);

    const resultA = await BusQuery.verifyChainIntegrity(sessionA.id);
    const resultB = await BusQuery.verifyChainIntegrity(sessionB.id);

    expect(resultA.valid).toBe(true);
    expect(resultB.valid).toBe(true);
  });

  test("event_chain survives CASCADE delete of bus_event", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 3; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-${i}`,
        time: 8000 + i,
        index: i,
      });
    }

    await persistedRows(3);
    const chainBefore = chainRows(session.id);
    expect(chainBefore).toHaveLength(3);

    db().query("DELETE FROM session WHERE id = ?").run(session.id);

    expect(busRows(session.id)).toHaveLength(0);

    const chainAfter = chainRows(session.id);
    expect(chainAfter).toHaveLength(3);
    expect(chainAfter.map((r) => r.event_hash)).toEqual(chainBefore.map((r) => r.event_hash));
  });

  test("audit chain rows persist ordered and hash-linked", async () => {
    const session = createSession();
    BusPersistence.start();

    for (let i = 0; i < 3; i++) {
      Bus.publish(testEvent, {
        sessionId: session.id,
        traceId: `trace-${i}`,
        time: 9000 + i,
        index: i,
      });
    }

    await persistedRows(3);
    const audit = chainRows(session.id);

    expect(audit).toHaveLength(3);
    const [audit0, audit1, audit2] = audit;
    if (audit0 === undefined || audit1 === undefined || audit2 === undefined) {
      throw new Error("shape");
    }
    expect(audit0.prev_hash).toBe(GENESIS_SEED);
    expect(audit1.prev_hash).toBe(audit0.event_hash);
    expect(audit2.prev_hash).toBe(audit1.event_hash);
    for (const record of audit) {
      expect(record.session_id).toBe(session.id);
      expect(record.event_type).toBe("test.hash.event");
    }
  });

  test("verifyChainIntegrity returns valid for empty session", async () => {
    const result = await BusQuery.verifyChainIntegrity("nonexistent");
    expect(result).toEqual({ valid: true, totalVerified: 0 });
  });

  test("computeEventHash is deterministic", () => {
    const input = {
      prevHash: GENESIS_SEED,
      eventType: "test.event",
      data: '{"ok":true}',
      traceId: "trace-deterministic",
      timeCreated: 10000,
    };

    const hash1 = computeEventHash(input);
    const hash2 = computeEventHash(input);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});
