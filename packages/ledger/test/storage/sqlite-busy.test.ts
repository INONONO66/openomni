import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
