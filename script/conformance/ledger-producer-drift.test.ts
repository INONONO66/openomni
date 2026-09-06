import { createDispositionFixture } from "../../packages/ledger/test/helpers/disposition-967";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { buildLedgerArchiveManifest } from "../generate-ledger-archive-manifest";
import {
  LEDGER_PRODUCER_MANIFEST,
  matchesFrozenTableWriteSql,
  matchesCommitExecutorCall,
  matchesLedgerTableWriteSql,
  matchesLedgerWriteCall,
  matchesMigrationTableWriteSql,
  scanLedgerProducers,
} from "../ledger-producer-manifest";

const repoRoot = join(import.meta.dir, "..", "..");
const adapterBinding = "packages/ledger/src/storage/sqlite-storage.ts";



describe("ledger producer drift", () => {
  test.each(['"ledger_event"', '`ledger_event`', '[ledger_event]', 'main.ledger_event', '"main" . "ledger_event"', '[main].[ledger_event]'])
  ("recognizes executable SQLite identifier %s in sources and migrations", (identifier) => {
    using db = new Database(":memory:");
    db.exec("CREATE TABLE ledger_event (id TEXT)");
    const sql = `INSERT INTO ${identifier} (id) VALUES ('writer')`;
    db.exec(sql);
    expect(matchesLedgerTableWriteSql(`db.exec(${JSON.stringify(sql)})`)).toBe(true);
    expect(matchesMigrationTableWriteSql(sql)).toBe(true);
  });

  test("discovers quoted writers while excluding production-tree tests and unrelated tables", async () => {
    const root = mkdtempSync(join(tmpdir(), "openomni-producers-"));
    try {
      mkdirSync(join(root, "apps/probe/src/__tests__"), { recursive: true });
      mkdirSync(join(root, "packages/probe/migration/0001"), { recursive: true });
      const write = 'db.exec(`UPDATE "main"."ledger_head" SET head = 1`)';
      for (const name of ["writer.tsx", "ignored.spec.ts", "ignored.test.tsx", "__tests__/ignored.ts"]) {
        writeFileSync(join(root, "apps/probe/src", name), write);
      }
      writeFileSync(join(root, "apps/probe/src/read.ts"), 'db.exec(`SELECT * FROM "ledger_head"`); db.exec(`UPDATE "ledger_head_extra" SET head = 1`)');
      writeFileSync(join(root, "packages/probe/migration/0001/migration.sql"), 'DELETE FROM [main].[worker_run_state];');
      expect(await scanLedgerProducers(root)).toEqual({
        appendCallSites: [], ledgerTableWriters: ["apps/probe/src/writer.tsx"], frozenTableWriters: [],
        migrationSqlWriters: ["packages/probe/migration/0001/migration.sql"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the observed write surface equals the manifest in both directions", async () => {
    const scan = await scanLedgerProducers(repoRoot);

    expect(LEDGER_PRODUCER_MANIFEST.appendCore).toContain(adapterBinding);
    // The write surface counts BOTH direct appenders and callers of the shared
    // commit executor: delegating the mechanics does not exempt a module from
    // the manifest, or the executor would become a laundering channel for
    // unmanifested stream classes.
    expect([...scan.appendCallSites].sort()).toEqual(
      [
        ...LEDGER_PRODUCER_MANIFEST.streams.flatMap((entry) => entry.producers),
        LEDGER_PRODUCER_MANIFEST.sharedAppendExecutor,
        adapterBinding,
      ].sort(),
    );
    expect([...scan.ledgerTableWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.appendCore.filter((file) => file !== adapterBinding).sort(),
    );
    expect([...scan.frozenTableWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.frozenTableWriters.map((entry) => entry.adapter).sort(),
    );
    expect([...scan.migrationSqlWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.migrationSqlWriters.map((entry) => entry.file).sort(),
    );
  });

  test("scanner red proofs cover the declared write shapes without false positives", () => {
    expect(
      matchesLedgerTableWriteSql(
        `db.query(\`insert or replace\n into\n ledger_head (stream_id, head) VALUES (?, ?)\`)`,
      ),
    ).toBe(true);
    expect(matchesLedgerTableWriteSql("run(`REPLACE\nINTO ledger_event VALUES (?)`)")).toBe(true);
    expect(matchesFrozenTableWriteSql("db.exec(`UPDATE\n worker_run_state SET status=?`)")).toBe(
      true,
    );
    expect(matchesLedgerWriteCall("const out = subLedger.append(event, 0);")).toBe(true);
    expect(matchesLedgerWriteCall('ledger["append"]({ streamId }, 0);')).toBe(true);
    expect(matchesLedgerWriteCall('store["adoptStream"](id, 3, genesis);')).toBe(true);
    expect(matchesLedgerWriteCall("adapter.adoptStream(\n streamId,\n head,\n genesis) ")).toBe(
      true,
    );
    expect(matchesLedgerWriteCall("const write = ledger.append.bind(ledger); write(event, 0)")).toBe(
      true,
    );
    expect(matchesLedgerWriteCall('const write = ledger["append"]; write(event, 0)')).toBe(true);
    expect(matchesLedgerWriteCall("const write = (ledger).append; write(event, 0)")).toBe(true);
    expect(matchesLedgerWriteCall("const write = (ledger as Ledger).append; write(event, 0)")).toBe(
      true,
    );
    expect(matchesLedgerWriteCall("const write = (ledger satisfies Ledger).append")).toBe(true);
    expect(matchesLedgerWriteCall("const { append: write } = adapter.ledger; write(event, 0)")).toBe(
      true,
    );
    expect(matchesLedgerWriteCall("const { adoptStream } = adapter; adoptStream(id, 1, fact)")).toBe(
      true,
    );
    expect(
      matchesMigrationTableWriteSql(
        "-- historical backfill\nUPDATE worker_run_state SET executor_kind = 'internal_chat_agent';",
      ),
    ).toBe(true);

    // Shared commit-executor entries: invocation, alias, bind, destructure,
    // and bracket access all identify the calling module.
    expect(matchesCommitExecutorCall("const out = commitFact(ledger, request, project);")).toBe(
      true,
    );
    expect(matchesCommitExecutorCall("commitFact(\n ledger,\n request,\n project)")).toBe(true);
    expect(matchesCommitExecutorCall("const write = commitFact; write(ledger, req, p)")).toBe(true);
    expect(matchesCommitExecutorCall("const write = commitFact.bind(null); write(l, r, p)")).toBe(
      true,
    );
    expect(
      matchesCommitExecutorCall('const { commitFact } = await import("./coordinator.js");'),
    ).toBe(true);
    expect(matchesCommitExecutorCall('coordinator["commitFact"](ledger, request, project);')).toBe(
      true,
    );
    // ...and prose about it is not a call.
    expect(matchesCommitExecutorCall("// commitFactoid is unrelated")).toBe(false);
    expect(matchesCommitExecutorCall("/* see commitFact for the ordering rules */")).toBe(false);

    expect(matchesLedgerWriteCall("// calls Ledger.append(event, expectedHead) later")).toBe(false);
    expect(matchesLedgerTableWriteSql("db.query(`SELECT * FROM ledger_event`)")).toBe(false);
    expect(matchesMigrationTableWriteSql("INSERT INTO worker_run_state_new (id) VALUES (1);")).toBe(
      false,
    );
  });

  test("manifest stream producers are unique", () => {
    const producers = LEDGER_PRODUCER_MANIFEST.streams.flatMap((entry) => entry.producers);
    expect(new Set(producers).size).toBe(producers.length);
    for (const entry of LEDGER_PRODUCER_MANIFEST.streams) {
      expect(entry.producers.length).toBe(1);
    }
  });

  test("historical archives remain inspectable with no live frozen-table writers", () => {
    using fixture = createDispositionFixture();
    const archived = buildLedgerArchiveManifest(fixture.db).tables.map((entry) => entry.table);
    const writers = LEDGER_PRODUCER_MANIFEST.frozenTableWriters.map((entry) => entry.table);
    expect(writers).toEqual([]);
    expect(archived).toEqual(expect.arrayContaining([...writers, "bus_event", "wait", "message", "part"]));
    expect(writers).not.toContain("bus_event");
    expect(writers).not.toContain("message");
    expect(writers).not.toContain("part");
  });
});
