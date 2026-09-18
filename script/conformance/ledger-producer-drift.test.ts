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

describe("decision fact producer drift", () => {
  test.each([
    '"decision_fact"',
    "`decision_fact`",
    "[decision_fact]",
    "main.decision_fact",
    '"main" . "decision_fact"',
    "[main].[decision_fact]",
  ])("recognizes executable SQLite identifier %s in sources and migrations", (identifier) => {
    using db = new Database(":memory:");
    db.exec("CREATE TABLE decision_fact (id TEXT)");
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
      const write = 'db.exec(`UPDATE "main"."decision_fact" SET data = 1`)';
      for (const name of [
        "writer.tsx",
        "ignored.spec.ts",
        "ignored.test.tsx",
        "__tests__/ignored.ts",
      ]) {
        writeFileSync(join(root, "apps/probe/src", name), write);
      }
      writeFileSync(
        join(root, "apps/probe/src/read.ts"),
        'db.exec(`SELECT * FROM "decision_fact"`); db.exec(`UPDATE "decision_fact_extra" SET data = 1`)',
      );
      writeFileSync(
        join(root, "packages/probe/migration/0001/migration.sql"),
        "DELETE FROM [main].[worker_run_state];",
      );
      expect(await scanLedgerProducers(root)).toEqual({
        recordCallSites: [],
        decisionTableWriters: ["apps/probe/src/writer.tsx"],
        frozenTableWriters: [],
        migrationSqlWriters: ["packages/probe/migration/0001/migration.sql"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the observed write surface equals the manifest in both directions", async () => {
    const scan = await scanLedgerProducers(repoRoot);
    expect(LEDGER_PRODUCER_MANIFEST.recordCore).toContain(adapterBinding);
    expect([...scan.recordCallSites].sort()).toEqual(
      [
        ...LEDGER_PRODUCER_MANIFEST.streams.flatMap((entry) => entry.producers),
        adapterBinding,
      ].sort(),
    );
    expect([...scan.decisionTableWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.recordCore.filter((file) => file !== adapterBinding).sort(),
    );
    expect([...scan.frozenTableWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.frozenTableWriters.map((entry) => entry.adapter).sort(),
    );
    expect([...scan.migrationSqlWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.migrationSqlWriters.map((entry) => entry.file).sort(),
    );
  });

  test.each([
    "const out = subDecisionFacts.record(fact);",
    'decisionFacts["record"]({ key });',
    "decisionFacts.record(\n fact\n)",
    "const write = decisionFacts.record.bind(decisionFacts); write(fact)",
    'const write = decisionFacts["record"]; write(fact)',
    "const write = (decisionFacts).record; write(fact)",
    "const write = (decisionFacts as Port).record; write(fact)",
    "const write = (decisionFacts satisfies Port).record",
    "const { record: write } = adapter.decisionFacts; write(fact)",
    "decisionFacts!.record(fact)",
    "decisionFacts?.record(fact)",
  ])("recognizes record capability %s", (source) =>
    expect(matchesLedgerWriteCall(source)).toBe(true));

  test("scanner red proofs cover SQL writes and reject false positives", () => {
    expect(
      matchesLedgerTableWriteSql(
        "db.query(`insert or replace\n into\n decision_fact (key, data) VALUES (?, ?)`)",
      ),
    ).toBe(true);
    expect(matchesLedgerTableWriteSql("run(`REPLACE\nINTO decision_fact VALUES (?)`)")).toBe(true);
    expect(matchesFrozenTableWriteSql("db.exec(`UPDATE\n worker_run_state SET status=?`)")).toBe(
      true,
    );
    expect(
      matchesMigrationTableWriteSql(
        "-- historical backfill\nUPDATE worker_run_state SET executor_kind = 'internal_chat_agent';",
      ),
    ).toBe(true);
    expect(matchesLedgerWriteCall("// decisionFacts.record(fact)")).toBe(false);
    expect(matchesLedgerWriteCall("const value = decisionFacts.head(key)")).toBe(false);
    expect(matchesLedgerTableWriteSql("db.query(`SELECT * FROM decision_fact`)")).toBe(false);
    expect(matchesMigrationTableWriteSql("INSERT INTO worker_run_state_new (id) VALUES (1);")).toBe(
      false,
    );
  });

  test.each([
    "const out = commitFact(port, request, project);",
    "commitFact(\n port,\n request,\n project)",
    "const write = commitFact; write(port, req, p)",
    "const write = commitFact.bind(null); write(l, r, p)",
    'const { commitFact } = await import("./coordinator.js");',
    'coordinator["commitFact"](port, request, project);',
  ])("shared write executor cannot bypass census: %s", (source) =>
    expect(matchesCommitExecutorCall(source)).toBe(true));

  test("shared executor comments are not capabilities", () => {
    expect(matchesCommitExecutorCall("// commitFactoid is unrelated")).toBe(false);
    expect(matchesCommitExecutorCall("/* see commitFact for the ordering rules */")).toBe(false);
  });

  test("manifest producers are unique", () => {
    const producers = LEDGER_PRODUCER_MANIFEST.streams.flatMap((entry) => entry.producers);
    expect(new Set(producers).size).toBe(producers.length);
    for (const entry of LEDGER_PRODUCER_MANIFEST.streams) expect(entry.producers.length).toBe(1);
  });

  test("historical archives remain inspectable with no live frozen-table writers", () => {
    using fixture = createDispositionFixture();
    const archived = buildLedgerArchiveManifest(fixture.db).tables.map((entry) => entry.table);
    const writers = LEDGER_PRODUCER_MANIFEST.frozenTableWriters.map((entry) => entry.table);
    expect(writers).toEqual([]);
    expect(archived).toEqual(expect.arrayContaining(["bus_event", "wait", "message", "part"]));
  });
});
