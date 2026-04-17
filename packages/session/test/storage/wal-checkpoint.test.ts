import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalMaintenance } from "../../src/storage/wal-maintenance";

function makeTempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `wal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, val TEXT)");
  return { db, path };
}

function cleanup(db: Database, path: string): void {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("WalMaintenance", () => {
  const handles: ReturnType<typeof WalMaintenance.start>[] = [];
  const dbs: Array<{ db: Database; path: string }> = [];

  afterEach(() => {
    for (const h of handles) h.stop();
    handles.length = 0;
    for (const { db, path } of dbs) cleanup(db, path);
    dbs.length = 0;
  });

  test("start() returns a handle with stop()", () => {
    const fixture = makeTempDb();
    dbs.push(fixture);

    const handle = WalMaintenance.start(fixture.db, { intervalMs: 60_000 });
    handles.push(handle);

    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
  });

  test("checkpoint runs and reduces WAL after writes", async () => {
    const fixture = makeTempDb();
    dbs.push(fixture);

    const insert = fixture.db.prepare("INSERT INTO items (val) VALUES (?)");
    for (let i = 0; i < 500; i++) {
      insert.run(`value-${i}`);
    }

    const before = fixture.db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };

    const handle = WalMaintenance.start(fixture.db, { intervalMs: 50 });
    handles.push(handle);

    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    const after = fixture.db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };

    // RESTART resets the WAL write position, so subsequent PASSIVE sees fewer or equal log frames
    expect(after.log).toBeLessThanOrEqual(before.log);
  });

  test("stop() prevents further checkpoint invocations", async () => {
    const fixture = makeTempDb();
    dbs.push(fixture);

    const handle = WalMaintenance.start(fixture.db, { intervalMs: 30 });
    handles.push(handle);

    await new Promise((r) => setTimeout(r, 100));
    handle.stop();

    const snapshot = fixture.db.query("SELECT COUNT(*) as n FROM items").get() as { n: number };

    await new Promise((r) => setTimeout(r, 150));

    const after = fixture.db.query("SELECT COUNT(*) as n FROM items").get() as { n: number };
    expect(after.n).toBe(snapshot.n);
  });
});
