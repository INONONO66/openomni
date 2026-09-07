import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDispositionFixture,
  seedRetiredWait,
  snapshotDatabase,
} from "../packages/ledger/test/helpers/disposition-967";
import {
  archiveAndVerify,
  archiveCli,
  disposeCli,
  manifestHash,
} from "../packages/ledger/test/helpers/disposition-967-cli";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import {
  buildLedgerArchiveManifest,
  writeArchiveManifestAtomically,
} from "./generate-ledger-archive-manifest";
import "./ledger-archive-fault.test";

describe("967 archive and guarded disposal", () => {
  test("enumerates every target and protected table before disposal", () => {
    using fixture = createDispositionFixture();
    const tables = buildLedgerArchiveManifest(fixture.db).tables.map((entry) => entry.table);
    for (const table of [
      "bus_event",
      "wait",
      "message",
      "part",
      "session",
      "action",
      "inbox",
      "alarm",
      "ledger_event",
      "ledger_head",
      "event_chain",
    ]) {
      expect(tables).toContain(table);
    }
  });
});

describe("967 real CLI disposal matrix", () => {
  test.each([
    "cancelled",
    "expired",
    "resolved",
  ] as const)("disposes only archived eligible %s rows and is resumable", (status) => {
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db, status);
    const before = snapshotDatabase(fixture.db);
    archiveAndVerify(fixture);
    const archive = readFileSync(fixture.archive);
    const manifest = readFileSync(fixture.manifest);
    expect(disposeCli(fixture).exitCode).toBe(0);
    const after = snapshotDatabase(fixture.db);
    const emptyRetiredTables = ["delegation", "worker_grant", "worker_run_state"];
    for (const table of emptyRetiredTables) {
      expect(before.tables.find(({ name }) => name === table)?.rows).toEqual([]);
      expect(after.tables.some(({ name }) => name === table)).toBe(false);
    }
    expect(after.tables.find(({ name }) => name === "reply_grant")?.rows).toEqual([]);
    const changedTables = [
      "bus_event",
      "wait",
      "_migrations",
      "sqlite_sequence",
      "reply_grant",
      ...emptyRetiredTables,
    ];
    expect(after.tables.filter(({ name }) => !changedTables.includes(name))).toEqual(
      before.tables.filter(({ name }) => !changedTables.includes(name)),
    );
    expect(fixture.db.query("SELECT id FROM wait WHERE owner_kind <> 'session'").all()).toEqual([]);
    expect(after.tables.find(({ name }) => name === "wait")?.rows).toEqual(
      before.tables.find(({ name }) => name === "wait")?.rows.filter((row) => row.id !== "retired"),
    );
    if (status === "cancelled") {
      console.log("967 raw SQLite before", Bun.inspect(before, { depth: 10, colors: false }));
      console.log("967 raw SQLite after", Bun.inspect(after, { depth: 10, colors: false }));
      console.log("967 manifest receipt", manifest.toString("utf8"));
    }
    expect(after.schema.some(({ name }) => name === "bus_event")).toBe(false);
    expect(disposeCli(fixture).exitCode).toBe(0);
    expect(snapshotDatabase(fixture.db)).toEqual(after);
    expect(readFileSync(fixture.archive)).toEqual(archive);
    expect(readFileSync(fixture.manifest)).toEqual(manifest);
  });

  test.each([
    "UPDATE wait SET status = 'open', revision = 0, data = json_remove(json_set(data, '$.status', 'open', '$.revision', 0), '$.cancelledAt')",
    "UPDATE wait SET data = '{'",
    "UPDATE wait SET data = json_set(data, '$.ownerRef.kind', 'session')",
    "UPDATE wait SET data = json_remove(data, '$.ownerRef')",
    "UPDATE wait SET owner_kind = 'WorkItem'",
    "UPDATE wait SET revision = 9",
    "UPDATE wait SET partial = 1",
    "UPDATE wait SET reply_to_message_id = 'changed'",
    "UPDATE wait SET follow_up_until = 123",
    'UPDATE wait SET data = replace(data, \'"id":"retired"\', \'"id":"other","id":"retired"\')',
  ])("refuses protected or incoherent projection unchanged: %s", (sql) => {
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db);
    fixture.db.run(sql);
    const before = snapshotDatabase(fixture.db);
    archiveAndVerify(fixture);
    expect(disposeCli(fixture).exitCode).toBe(1);
    expect(snapshotDatabase(fixture.db)).toEqual(before);
  });

  test.each([
    "missing-hash",
    "wrong-hash",
    "manifest",
    "backup",
    "stale",
  ])("refuses %s without source mutation", (fault) => {
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db);
    archiveAndVerify(fixture);
    const hash = manifestHash(fixture);
    if (fault === "manifest") appendFileSync(fixture.manifest, "\n");
    if (fault === "backup") appendFileSync(fixture.archive, "X");
    if (fault === "stale") fixture.db.run("UPDATE message SET data = 'changed'");
    const before = snapshotDatabase(fixture.db);
    const flags =
      fault === "missing-hash"
        ? ["--dispose-967"]
        : [
            "--dispose-967",
            "--approve-manifest-sha256",
            fault === "wrong-hash" ? "0".repeat(64) : hash,
          ];
    expect(archiveCli(fixture, flags).exitCode).toBe(1);
    expect(snapshotDatabase(fixture.db)).toEqual(before);
  });

  test("already-applied acknowledgement refuses a surviving retired projection", () => {
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db);
    archiveAndVerify(fixture);
    expect(disposeCli(fixture).exitCode).toBe(0);
    seedRetiredWait(fixture.db);
    const before = snapshotDatabase(fixture.db);
    expect(disposeCli(fixture).exitCode).toBe(1);
    expect(snapshotDatabase(fixture.db)).toEqual(before);
  });

  test.each(["-wal", "-shm", "-journal"])("refuses source sidecar collision %s", (suffix) => {
    using fixture = createDispositionFixture();
    const before = snapshotDatabase(fixture.db);
    expect(archiveCli(fixture, ["--backup", `${fixture.path}${suffix}`]).exitCode).toBe(1);
    expect(snapshotDatabase(fixture.db)).toEqual(before);
  });

  test("never replaces prior artifacts", () => {
    using fixture = createDispositionFixture();
    archiveAndVerify(fixture);
    const archive = readFileSync(fixture.archive);
    const manifest = readFileSync(fixture.manifest);
    expect(archiveCli(fixture).exitCode).toBe(1);
    expect(readFileSync(fixture.archive)).toEqual(archive);
    expect(readFileSync(fixture.manifest)).toEqual(manifest);
  });

  test("native backup reopens with exact large integers, BLOBs, and committed WAL only", () => {
    using fixture = createDispositionFixture();
    fixture.db.run("PRAGMA journal_mode=WAL");
    fixture.db.run("PRAGMA wal_autocheckpoint=0");
    fixture.db.run("UPDATE message SET data = char(65, 0, 66)");
    const before = snapshotDatabase(fixture.db);
    const writer = new Database(fixture.path);
    writer.run("BEGIN IMMEDIATE");
    writer.run("UPDATE message SET data = 'uncommitted'");
    try {
      archiveAndVerify(fixture);
    } finally {
      writer.run("ROLLBACK");
      writer.close(true);
    }
    const copy = join(fixture.directory, "reopened.sqlite");
    copyFileSync(fixture.archive, copy);
    const restored = new Database(copy, { readwrite: true, safeIntegers: true });
    try {
      expect(snapshotDatabase(restored)).toEqual(before);
      expect(existsSync(`${fixture.archive}-wal`)).toBe(false);
      expect(existsSync(`${fixture.archive}-shm`)).toBe(false);
    } finally {
      restored.close(true);
    }
  });
});

describe("ledger archive manifest", () => {
  test("atomically replaces the manifest and retains the previous file if replacement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openomni-archive-manifest-"));
    const outPath = join(directory, "ledger-archive-manifest.json");
    try {
      await writeFile(outPath, "previous\n");
      await writeArchiveManifestAtomically(outPath, "replacement\n");
      expect(await readFile(outPath, "utf8")).toBe("replacement\n");
      expect(await readdir(directory)).toEqual(["ledger-archive-manifest.json"]);

      await expect(
        writeArchiveManifestAtomically(outPath, "partial\n", () => {
          throw new Error("injected replacement failure");
        }),
      ).rejects.toThrow("injected replacement failure");
      expect(await readFile(outPath, "utf8")).toBe("replacement\n");
      expect(await readdir(directory)).toEqual(["ledger-archive-manifest.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
