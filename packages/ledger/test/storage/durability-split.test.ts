import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { buildAppendInput } from "../helpers/ledger";

/**
 * #510 D1 durability split: the primary connection (owner of every
 * decision-class write) runs synchronous=FULL; telemetry gets its own
 * NORMAL connection on the same file, so a telemetry write can never join
 * a decision transaction. `:memory:` degrades to the single connection
 * (an in-memory database cannot be shared across connections).
 */

// PRAGMA synchronous integer levels.
const SYNCHRONOUS_NORMAL = 1;
const SYNCHRONOUS_FULL = 2;

interface AdapterInternals {
  readonly db: Database;
  readonly telemetryDb: Database;
}

function internals(adapter: SqliteStorageAdapter): AdapterInternals {
  return adapter as unknown as AdapterInternals;
}

function pragmaNumber(db: Database, pragma: "synchronous" | "busy_timeout"): number {
  const row = db.query(`PRAGMA ${pragma}`).get() as Record<string, number>;
  const value = row[pragma === "busy_timeout" ? "timeout" : pragma];
  if (typeof value !== "number") throw new Error(`PRAGMA ${pragma} returned no number`);
  return value;
}

describe("durability split (file-backed)", () => {
  let tempDir: string;
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "durability-split-"));
    adapter = new SqliteStorageAdapter(join(tempDir, "openomni.db"));
  });

  afterEach(() => {
    adapter.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("primary connection is FULL, telemetry connection is NORMAL, on distinct connections", () => {
    const { db, telemetryDb } = internals(adapter);

    expect(telemetryDb).not.toBe(db);
    expect(pragmaNumber(db, "synchronous")).toBe(SYNCHRONOUS_FULL);
    expect(pragmaNumber(telemetryDb, "synchronous")).toBe(SYNCHRONOUS_NORMAL);
  });

  test("WAL and busy_timeout pragmas are re-applied per connection", () => {
    const { db, telemetryDb } = internals(adapter);

    for (const connection of [db, telemetryDb]) {
      const journal = connection.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journal.journal_mode).toBe("wal");
      expect(pragmaNumber(connection, "busy_timeout")).toBe(5000);
    }
  });

  test("a telemetry write cannot join a decision-class transaction", () => {
    const { telemetryDb } = internals(adapter);
    // Shrink the test's wait for the lock; production keeps 5000ms.
    telemetryDb.query("PRAGMA busy_timeout = 50").get();

    adapter.transaction(() => {
      // The decision transaction (BEGIN IMMEDIATE) holds the write lock.
      // On the SAME connection this INSERT would silently join the
      // transaction; on the split connection it must be refused.
      expect(() =>
        telemetryDb
          .query("INSERT INTO ledger_head (stream_id, head) VALUES (?, 0)")
          .run("wait:telemetry-intrusion"),
      ).toThrow(/database is locked/i);
      // The decision path itself stays writable inside its transaction.
      const outcome = adapter.ledger.append(
        buildAppendInput({ streamId: "wait:durability-split" }),
        0,
      );
      expect(outcome.kind).toBe("appended");
    });

    // After the decision transaction commits, telemetry writes proceed and
    // see the committed fact (same file, WAL).
    const head = telemetryDb
      .query("SELECT head FROM ledger_head WHERE stream_id = ?")
      .get("wait:durability-split") as { head: number };
    expect(head.head).toBe(1);
  });

  test("telemetry insertion does not advance ledger events or owner heads", () => {
    const { db, telemetryDb } = internals(adapter);
    const counts = () => ({
      events: (db.query("SELECT COUNT(*) AS n FROM ledger_event").get() as { n: number }).n,
      heads: (db.query("SELECT COUNT(*) AS n FROM ledger_head").get() as { n: number }).n,
    });
    const before = counts();

    telemetryDb
      .query(
        `INSERT INTO bus_event
       (session_id, run_id, event_type, category, visibility, data, trace_id, duration_ms, time_created)
       VALUES (NULL, NULL, 'work_item.admission_accepted', 'work_item', 'internal', '{}', 'trace-test', NULL, 1)`,
      )
      .run();

    expect(counts()).toEqual(before);
  });

  test("close checkpoints the WAL into the main file (TRUNCATE)", () => {
    const dbPath = join(tempDir, "openomni.db");
    const outcome = adapter.ledger.append(buildAppendInput({ streamId: "wait:checkpoint" }), 0);
    expect(outcome.kind).toBe("appended");
    adapter.close();

    // Fresh connection with journaling OFF reads the MAIN file only — the
    // appended fact must have been folded out of the WAL by close().
    const reopened = new Database(dbPath, { readonly: true });
    try {
      const row = reopened
        .query("SELECT seq FROM ledger_event WHERE stream_id = ?")
        .get("wait:checkpoint") as { seq: number };
      expect(row.seq).toBe(1);
    } finally {
      reopened.close();
    }
    // afterEach closes again; re-open so its close() has a live handle.
    adapter = new SqliteStorageAdapter(dbPath);
  });
});

describe("durability split (:memory: degradation)", () => {
  test("telemetry degrades to the single connection", () => {
    const adapter = new SqliteStorageAdapter(":memory:");
    try {
      const { db, telemetryDb } = internals(adapter);
      // Documented degradation: an in-memory database cannot be shared
      // across connections, so the split collapses to one connection.
      expect(telemetryDb).toBe(db);
    } finally {
      adapter.close();
    }
  });
});
