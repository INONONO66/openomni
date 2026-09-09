import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migration } from "../../src/storage/migration-runner";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});

function apply(db: Database, sql: string) {
  const directory = mkdtempSync(join(tmpdir(), "ledger-sql-tokens-"));
  directories.push(directory);
  writeFileSync(join(directory, "fixture.sql"), sql);
  Migration.applyOrdered(db, directory, [{ name: "fixture.sql" }]);
}

test("migration runner preserves quoted semicolons, comments and nested CASE in triggers", () => {
  using db = new Database(":memory:");
  apply(
    db,
    `
    -- ignored ; CREATE TRIGGER
    CREATE TABLE "source;table" ([value;column] TEXT);
    CREATE TABLE output (value TEXT);
    /* semicolon ; and BEGIN END */
    create temporary trigger quoted after insert on "source;table"
    begin
      INSERT INTO output VALUES (CASE WHEN NEW.[value;column] = 'it''s;ok' THEN 'first;value' ELSE 'wrong' END);
      INSERT INTO output VALUES ('second;value');
    end;
    INSERT INTO "source;table" VALUES ('it''s;ok');
    CREATE TABLE \`back;tick\` (id TEXT);
    INSERT INTO \`back;tick\` VALUES ('last')
  `,
  );
  expect(db.query("SELECT value FROM output ORDER BY rowid").all()).toEqual([
    { value: "first;value" },
    { value: "second;value" },
  ]);
  expect(db.query('SELECT id FROM "back;tick"').get()).toEqual({ id: "last" });
});

test("migration statement failure rolls back prior writes and never executes a following drop", () => {
  using db = new Database(":memory:");
  db.run("CREATE TABLE retained (id TEXT)");
  db.run("INSERT INTO retained VALUES ('evidence')");
  expect(() =>
    apply(
      db,
      `CREATE TABLE transient (id TEXT); INSERT INTO missing VALUES ('bad;value'); DROP TABLE retained;`,
    ),
  ).toThrow();
  expect(db.query("SELECT id FROM retained").all()).toEqual([{ id: "evidence" }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'transient'").get()).toBeNull();
  expect(db.query("SELECT name FROM _migrations").all()).toEqual([]);
});

test.each([
  "CREATE TABLE bad (value TEXT DEFAULT 'unterminated)",
  'CREATE TABLE "unterminated (id TEXT)',
  "CREATE TABLE `unterminated (id TEXT)",
  "CREATE TABLE [unterminated (id TEXT)",
  "/* unterminated",
  "CREATE TRIGGER bad AFTER INSERT ON absent BEGIN SELECT 1;",
])("malformed migration refuses without recording completion: %s", (sql) => {
  using db = new Database(":memory:");
  expect(() => apply(db, sql)).toThrow();
  expect(db.query("SELECT name FROM _migrations").all()).toEqual([]);
});

test("empty statements and comment-only tails are not executed", () => {
  using db = new Database(":memory:");
  apply(db, ";; -- no statements\n /* still empty */");
  expect(db.query("SELECT name FROM _migrations").all()).toEqual([{ name: "fixture.sql" }]);
});
