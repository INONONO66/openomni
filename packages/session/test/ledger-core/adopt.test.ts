import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LedgerAppend } from "@openomni/protocol";
import { GENESIS_SEED } from "../../src/bus-persistence/hash";
import { Ledger } from "../../src/ledger-core/index";
import { appendChain, openLedgerDatabase } from "../helpers/ledger";

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

function readEvents(streamId: string): { seq: number; type: string; prev_hash: string }[] {
  return db
    .query("SELECT seq, type, prev_hash FROM ledger_event WHERE stream_id = ? ORDER BY seq ASC")
    .all(streamId) as { seq: number; type: string; prev_hash: string }[];
}

describe("Ledger.adoptStream", () => {
  test("adopts an empty stream: genesis fact at seq === headRevision, head = headRevision", () => {
    Ledger.adoptStream(db, "wait:pre-cutover", 3, {
      type: "wait.adopted",
      data: { snapshot: { id: "pre-cutover", revision: 3 }, revision: 3 },
      timeCreated: 1_000,
    });

    expect(readHead("wait:pre-cutover")).toBe(3);
    const events = readEvents("wait:pre-cutover");
    expect(events).toEqual([{ seq: 3, type: "wait.adopted", prev_hash: GENESIS_SEED }]);
    // The next transition appends at expectedHead === the adopted revision.
    const appended = Ledger.append(
      db,
      { streamId: "wait:pre-cutover", type: "wait.resolved", data: { revision: 4 } },
      3,
    );
    expect(appended.kind).toBe("appended");
    if (appended.kind !== "appended") throw new Error("expected appended");
    expect(appended.seq).toBe(4);
    expect(readHead("wait:pre-cutover")).toBe(4);
    // The adopted stream verifies clean: the genesis chains from the seed
    // and its missing predecessor lies below the oldest stored event.
    expect(Ledger.verifyTail(db)).toEqual([]);
  });

  test("a non-empty stream throws the typed AdoptError and writes nothing", () => {
    appendChain(db, 2, "work:occupied");

    let thrown: unknown;
    try {
      Ledger.adoptStream(db, "work:occupied", 5, {
        type: "work_item.adopted",
        data: { revision: 5 },
      });
    } catch (error) {
      thrown = error;
    }

    if (!LedgerAppend.AdoptError.isInstance(thrown)) {
      throw new Error("expected the typed LedgerAdoptError");
    }
    expect(thrown.data.streamId).toBe("work:occupied");
    expect(thrown.data.currentHead).toBe(2);
    expect(readHead("work:occupied")).toBe(2);
    expect(readEvents("work:occupied")).toHaveLength(2);
  });

  test("a second adoption of the same stream throws the typed AdoptError", () => {
    Ledger.adoptStream(db, "wait:once", 1, { type: "wait.adopted", data: { revision: 1 } });

    let thrown: unknown;
    try {
      Ledger.adoptStream(db, "wait:once", 1, { type: "wait.adopted", data: { revision: 1 } });
    } catch (error) {
      thrown = error;
    }

    if (!LedgerAppend.AdoptError.isInstance(thrown)) {
      throw new Error("expected the typed LedgerAdoptError");
    }
    expect(readEvents("wait:once")).toHaveLength(1);
  });

  test("headRevision must be a positive integer", () => {
    expect(() =>
      Ledger.adoptStream(db, "wait:zero", 0, { type: "wait.adopted", data: {} }),
    ).toThrow();
    expect(readEvents("wait:zero")).toHaveLength(0);
    expect(readHead("wait:zero")).toBeUndefined();
  });
});
