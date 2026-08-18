import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GENESIS_SEED } from "../../src/bus-persistence/hash";
import { createLedgerDb } from "./db";
import { Ledger } from "../../src/ledger-core/index";
import { ledgerEvent, ledgerHead } from "../../src/ledger-core/schema";
import {
  appendChain,
  buildAppendInput,
  captureThrown,
  openLedgerDatabase,
} from "../helpers/ledger";

let db: Database;

beforeEach(() => {
  db = openLedgerDatabase();
});

afterEach(() => {
  db.close();
});

function readHead(streamId: string): number | undefined {
  const row = db.query("SELECT head FROM ledger_head WHERE stream_id = ?").get(streamId) as {
    head: number;
  } | null;
  return row?.head;
}

function countEvents(streamId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM ledger_event WHERE stream_id = ?")
    .get(streamId) as { count: number };
  return row.count;
}

describe("Ledger.append", () => {
  test("matching expectedHead appends and advances the head exactly once", () => {
    const first = Ledger.append(db, buildAppendInput(), 0);

    if (first.kind !== "appended") throw new Error(`expected appended, got ${first.kind}`);
    expect(first.seq).toBe(1);
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readHead("stream-1")).toBe(1);

    const second = Ledger.append(db, buildAppendInput({ timeCreated: 1_001 }), 1);

    if (second.kind !== "appended") throw new Error(`expected appended, got ${second.kind}`);
    expect(second.seq).toBe(2);
    expect(readHead("stream-1")).toBe(2);
    expect(countEvents("stream-1")).toBe(2);
  });

  test("stale expectedHead returns typed cas_conflict and writes nothing", () => {
    appendChain(db, 1);

    const conflict = Ledger.append(db, buildAppendInput({ timeCreated: 2_000 }), 0);

    expect(conflict).toEqual({ kind: "cas_conflict", currentHead: 1 });
    expect(readHead("stream-1")).toBe(1);
    expect(countEvents("stream-1")).toBe(1);
  });

  test("nonzero expectedHead on an unknown stream conflicts at head 0 without creating the stream", () => {
    const conflict = Ledger.append(db, buildAppendInput({ streamId: "ghost" }), 3);

    expect(conflict).toEqual({ kind: "cas_conflict", currentHead: 0 });
    expect(readHead("ghost")).toBeUndefined();
    expect(countEvents("ghost")).toBe(0);
  });

  test("each stream CAS-advances independently", () => {
    appendChain(db, 2, "stream-a");
    appendChain(db, 1, "stream-b");

    expect(readHead("stream-a")).toBe(2);
    expect(readHead("stream-b")).toBe(1);
  });

  test("hash chain links prev_hash of N to event_hash of N-1 starting from the genesis seed", () => {
    const outcomes = appendChain(db, 3);

    const rows = db
      .query(
        "SELECT seq, prev_hash, event_hash FROM ledger_event WHERE stream_id = ? ORDER BY seq ASC",
      )
      .all("stream-1") as { seq: number; prev_hash: string; event_hash: string }[];

    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0]?.prev_hash).toBe(GENESIS_SEED);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.event_hash ?? "");
    expect(rows[2]?.prev_hash).toBe(rows[1]?.event_hash ?? "");
    expect(rows.map((row) => row.event_hash)).toEqual(outcomes.map((outcome) => outcome.eventHash));
  });

  test("composite PK explodes on a CAS-bypassing duplicate seq instead of silently succeeding", () => {
    appendChain(db, 1);

    const error = captureThrown(() =>
      db
        .query(
          `INSERT INTO ledger_event (stream_id, seq, type, data, prev_hash, event_hash, time_created)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("stream-1", 1, "decision.recorded", "{}", "forged", "forged", 1),
    );

    expect(error.message).toContain("UNIQUE constraint failed: ledger_event.stream_id");
    expect(countEvents("stream-1")).toBe(1);
  });
});

describe("Ledger.verifyTail", () => {
  test("intact chains across streams report no break facts", () => {
    appendChain(db, 3, "stream-a");
    appendChain(db, 2, "stream-b");

    expect(Ledger.verifyTail(db)).toEqual([]);
  });

  test("a tampered row reports a hash_mismatch fact without throwing", () => {
    appendChain(db, 3);
    db.query("UPDATE ledger_event SET data = ? WHERE stream_id = ? AND seq = ?").run(
      '{"note":"tampered"}',
      "stream-1",
      3,
    );

    const facts = Ledger.verifyTail(db, { now: 9_999 });

    expect(facts).toHaveLength(1);
    const fact = facts[0];
    if (fact === undefined) throw new Error("expected one chain-break fact");
    expect(fact.code).toBe("hash_mismatch");
    expect(fact.streamId).toBe("stream-1");
    expect(fact.seq).toBe(3);
    expect(fact.detectedAt).toBe(9_999);
    expect(fact.expected).not.toBe(fact.actual);
  });

  test("a rewritten event_hash reports the hash break and the successor link break", () => {
    appendChain(db, 3);
    db.query("UPDATE ledger_event SET event_hash = ? WHERE stream_id = ? AND seq = ?").run(
      "f".repeat(64),
      "stream-1",
      2,
    );

    const codes = Ledger.verifyTail(db)
      .map((fact) => `${fact.code}@${fact.seq}`)
      .sort();

    expect(codes).toEqual(["hash_mismatch@2", "link_mismatch@3"]);
  });

  test("a tampered head counter reports head_mismatch with both values", () => {
    appendChain(db, 3);
    db.query("UPDATE ledger_head SET head = 10 WHERE stream_id = ?").run("stream-1");

    const facts = Ledger.verifyTail(db);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      code: "head_mismatch",
      streamId: "stream-1",
      seq: 3,
      expected: "3",
      actual: "10",
    });
  });

  test("a deleted row inside the tail reports the successor's link_mismatch as missing", () => {
    appendChain(db, 3);
    db.query("DELETE FROM ledger_event WHERE stream_id = ? AND seq = ?").run("stream-1", 2);

    const facts = Ledger.verifyTail(db);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      code: "link_mismatch",
      streamId: "stream-1",
      seq: 3,
      expected: "event_hash of seq 2",
      actual: "missing",
    });
  });

  test("a genesis-link rewrite at seq 1 reports link_mismatch", () => {
    appendChain(db, 1);
    // Keep the row self-consistent (recomputable hash) except for the link.
    db.query("UPDATE ledger_event SET prev_hash = ? WHERE stream_id = ? AND seq = ?").run(
      "not-genesis",
      "stream-1",
      1,
    );

    const codes = Ledger.verifyTail(db).map((fact) => fact.code);

    // prev_hash participates in the event hash, so the rewrite surfaces as
    // both the broken genesis link and a hash mismatch.
    expect(codes).toContain("link_mismatch");
    expect(codes).toContain("hash_mismatch");
  });
});

describe("ledger-core drizzle schema parity", () => {
  test("drizzle snake_case mapping reads the rows the hand-written migration stored", () => {
    // DDL-parity check only: runtime append/verify SQL stays raw prepared
    // statements (decision-class rule); drizzle here proves schema.ts maps
    // onto migration/0013_ledger/migration.sql exactly.
    const [outcome] = appendChain(db, 1);
    if (outcome === undefined) throw new Error("expected one appended outcome");
    const ledgerDb = createLedgerDb(db);

    const events = ledgerDb.select().from(ledgerEvent).all();
    const heads = ledgerDb.select().from(ledgerHead).all();

    expect(events).toEqual([
      {
        streamId: "stream-1",
        seq: 1,
        type: "decision.recorded",
        data: '{"note":"fixture","value":0}',
        prevHash: GENESIS_SEED,
        eventHash: outcome.eventHash,
        timeCreated: 1_000,
      },
    ]);
    expect(heads).toEqual([{ streamId: "stream-1", head: 1 }]);
  });
});
