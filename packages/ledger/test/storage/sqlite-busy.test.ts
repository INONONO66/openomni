import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSqliteBusyError } from "../../src/storage/sqlite-busy";

describe("isSqliteBusyError", () => {
  test("matches a real bun:sqlite SQLITE_BUSY (pins how the driver surfaces it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-busy-"));
    const path = join(dir, "busy.db");
    const writer = new Database(path);
    const contender = new Database(path);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1;");
      writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      contender.exec("PRAGMA busy_timeout=1;");
      // Hold the write lock on one connection; the contender's immediate
      // transaction must surface SQLITE_BUSY.
      writer.exec("BEGIN IMMEDIATE");
      writer.exec("INSERT INTO t (v) VALUES ('holder')");

      let thrown: unknown;
      try {
        contender
          .transaction(() => {
            contender.query("INSERT INTO t (v) VALUES ('contender')").run();
          })
          .immediate();
      } catch (error) {
        thrown = error;
      }
      writer.exec("COMMIT");

      // Empirical pin: bun:sqlite throws SQLiteError { code: "SQLITE_BUSY",
      // errno: 5, message: "database is locked" } — the predicate's contract.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: unknown }).code).toBe("SQLITE_BUSY");
      expect(isSqliteBusyError(thrown)).toBe(true);
    } finally {
      contender.close();
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("matches extended SQLITE_BUSY_* result codes and rejects everything else", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 });
    const snapshot = Object.assign(new Error("snapshot"), { code: "SQLITE_BUSY_SNAPSHOT" });
    expect(isSqliteBusyError(busy)).toBe(true);
    expect(isSqliteBusyError(snapshot)).toBe(true);

    expect(isSqliteBusyError(new Error("database is locked"))).toBe(false);
    expect(isSqliteBusyError(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBe(
      false,
    );
    expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
  });
});
