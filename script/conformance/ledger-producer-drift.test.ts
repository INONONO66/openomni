import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger as LedgerTypes } from "../../packages/protocol/src/index";
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

  test("manifest stream classes equal the protocol registry and producers are unique", () => {
    const classes: string[] = LEDGER_PRODUCER_MANIFEST.streams.map((entry) => entry.streamClass);
    expect(classes.sort()).toEqual(Object.keys(LedgerTypes.StreamRegistry).sort());
    const producers = LEDGER_PRODUCER_MANIFEST.streams.flatMap((entry) => entry.producers);
    expect(new Set(producers).size).toBe(producers.length);
    for (const entry of LEDGER_PRODUCER_MANIFEST.streams) {
      expect(entry.producers.length).toBe(1);
    }
  });

  test("producer and archive manifests agree on the frozen-table set", () => {
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE _migrations (name TEXT NOT NULL)");
      db.run("INSERT INTO _migrations VALUES ('test')");
      db.run("CREATE TABLE worker_run_state (run_id TEXT PRIMARY KEY)");
      const archived = buildLedgerArchiveManifest(db).tables.map((entry) => entry.table);
      expect(
        LEDGER_PRODUCER_MANIFEST.frozenTableWriters.map((entry) => entry.table).sort(),
      ).toEqual(archived.sort());
    } finally {
      db.close();
    }
  });
});
