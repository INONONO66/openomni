import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Migration } from "../../src/storage/migration-runner";
import { RETIRED_TABLE_MIGRATION } from "../../src/storage/u967-preflight";
import { createDispositionFixture, snapshotDatabase } from "../helpers/disposition-967";

const directory = resolve(import.meta.dir, "../../migration");
const sql = readFileSync(resolve(directory, RETIRED_TABLE_MIGRATION), "utf8");
const created = new Set([...sql.matchAll(/CREATE TABLE ([a-z_]+)/g)].map((match) => match[1]));
const retired = [...sql.matchAll(/DROP TABLE ([a-z_]+)/g)]
  .map((match) => match[1])
  .filter((name): name is string => name !== undefined && !created.has(name));

for (const table of retired) {
  test(`message migration refuses a retained ${table} row atomically`, () => {
    using fixture = createDispositionFixture(false);
    using columns = fixture.db.prepare<
      { name: string; type: string; notnull: bigint; pk: bigint },
      []
    >(`PRAGMA table_info("${table}")`);
    const required = columns.all().filter((column) => column.notnull !== 0n || column.pk !== 0n);
    const names = required.map((column) => `"${column.name}"`).join(",");
    const values = required.map((column) =>
      column.type === "INTEGER" ? 0 : column.name === "status" ? "open" : "{}",
    );
    fixture.db
      .query(`INSERT INTO "${table}" (${names}) VALUES (${values.map(() => "?").join(",")})`)
      .run(...values);
    const before = snapshotDatabase(fixture.db);
    expect(() =>
      Migration.applyOrdered(fixture.db, directory, [{ name: RETIRED_TABLE_MIGRATION }]),
    ).toThrow();
    expect(snapshotDatabase(fixture.db)).toEqual(before);
    expect(
      fixture.db.query("SELECT name FROM _migrations WHERE name = ?").all(RETIRED_TABLE_MIGRATION),
    ).toEqual([]);
  });
}

test("the guarded migration succeeds with empty retired tables", () => {
  expect(retired).toHaveLength(3);
  using db = new Database(":memory:");
  for (const table of retired) db.exec(`CREATE TABLE "${table}" (id TEXT)`);
  Migration.applyOrdered(db, directory, [{ name: RETIRED_TABLE_MIGRATION }]);
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(["_migrations"]);
});
