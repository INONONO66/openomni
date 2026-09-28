import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeSqliteDatabase,
  preflightSqliteDatabase,
} from "../../src/storage/sqlite-schema-lifecycle";

test("SQLite write contention surfaces the driver error without committing the contender", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-busy-"));
  const path = join(directory, "busy.db");
  const writer = new Database(path);
  const contender = new Database(path);
  try {
    writer.run("PRAGMA journal_mode=WAL");
    contender.run("PRAGMA busy_timeout=0");
    writer.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    writer
      .transaction(() => {
        writer.query("INSERT INTO t (v) VALUES (?)").run("holder");
        expect(() =>
          contender
            .transaction(() => {
              contender.query("INSERT INTO t (v) VALUES (?)").run("contender");
            })
            .immediate(),
        ).toThrow(expect.objectContaining({ code: "SQLITE_BUSY", errno: 5 }));
      })
      .immediate();
    expect(writer.query("SELECT v FROM t").all()).toEqual([{ v: "holder" }]);
  } finally {
    contender.close();
    writer.close();
    rmSync(directory, { recursive: true });
  }
});

// W5.2 review F9 regression: busy_timeout must be applied before ANY preflight
// query so a concurrent multi-process open waits instead of failing instantly
// with SQLITE_BUSY. The pragma is connection-local (it never touches the db
// file), so a non-SQLite payload makes the first file-touching read throw —
// observing busy_timeout=5000 on the connection after that throw proves the
// pragma ran strictly before the first preflight query.
function nonSqlitePayload(directory: string): string {
  const path = join(directory, "notadb.sqlite");
  writeFileSync(path, "this file is deliberately not a sqlite database; header magic is absent");
  return path;
}

test("F9: preflightSqliteDatabase applies busy_timeout before its first schema read", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-busy-"));
  const db = new Database(nonSqlitePayload(directory));
  try {
    expect(() => preflightSqliteDatabase(db)).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB", errno: 26 }),
    );
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

test("F9: initializeSqliteDatabase applies busy_timeout before its preflight read", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-busy-"));
  const db = new Database(nonSqlitePayload(directory));
  try {
    expect(() => initializeSqliteDatabase(db)).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB", errno: 26 }),
    );
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});
