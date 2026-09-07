import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigest } from "@openomni/protocol";
import { assertArchiveEquality } from "../../../../script/ledger-archive-snapshot";
import { createDispositionFixture, snapshotDatabase } from "../helpers/disposition-967";
import {
  initializeSqliteDatabase,
  preflightSqliteDatabase,
} from "../../src/storage/sqlite-schema-lifecycle";
import { sqliteSchema } from "../../src/storage/u967-preflight";
import { Migration } from "../../src/storage/migration-runner";

const migrationDir = join(import.meta.dir, "../../migration");

test("0035 upgrade and fresh 0036 schema share the measured fingerprint and reopen", () => {
  using fixture = createDispositionFixture(false);
  fixture.db.run("DELETE FROM bus_event");
  Migration.applyOrdered(fixture.db, migrationDir, [
    { name: "0034_u967_archive_disposition/migration.sql" },
    { name: "0035_drop_retired_delegation_tables/migration.sql" },
  ]);
  const before = snapshotDatabase(fixture.db);

  initializeSqliteDatabase(fixture.db);

  expect(canonicalDigest(sqliteSchema(fixture.db))).toBe(
    "sha256:89e7677fe96971ec5ff5f8176504f42a478ae4fd8dfa84e4e18560077279e0ff",
  );
  expect(
    snapshotDatabase(fixture.db).tables.filter(
      ({ name }) => !["_migrations", "reply_grant"].includes(name),
    ),
  ).toEqual(before.tables.filter(({ name }) => name !== "_migrations"));
  expect(preflightSqliteDatabase(fixture.db)).toBe("applied");
  using reopened = new Database(fixture.path);
  initializeSqliteDatabase(reopened);
  expect(sqliteSchema(reopened)).toEqual(sqliteSchema(fixture.db));
  using fresh = new Database(":memory:");
  initializeSqliteDatabase(fresh);
  expect(sqliteSchema(fresh)).toEqual(sqliteSchema(reopened));
});

test("the old archive allows only an empty pinned forward projection", () => {
  using fixture = createDispositionFixture(false);
  copyFileSync(fixture.path, fixture.archive);
  using archived = new Database(fixture.archive, { readonly: true, safeIntegers: true });
  initializeSqliteDatabase(fixture.db, (db) => db.run("DELETE FROM bus_event"));
  expect(() => assertArchiveEquality(fixture.db, archived, true)).not.toThrow();

  fixture.db.run("INSERT INTO reply_grant VALUES ('new', '{}', 'rule', 'actor', 'surface', 100)");

  expect(() => assertArchiveEquality(fixture.db, archived, true)).toThrow(
    "stale_archive:reply_grant",
  );
});

test("archive comparison refuses schema drift even on an empty added projection", () => {
  using fixture = createDispositionFixture(false);
  copyFileSync(fixture.path, fixture.archive);
  using archived = new Database(fixture.archive, { readonly: true, safeIntegers: true });
  initializeSqliteDatabase(fixture.db, (db) => db.run("DELETE FROM bus_event"));

  fixture.db.run("DROP INDEX idx_reply_grant_expiry");

  expect(() => assertArchiveEquality(fixture.db, archived, true)).toThrow("unsupported_upgrade");
  expect(() => preflightSqliteDatabase(fixture.db)).toThrow("unsupported_upgrade");
});

test("an archive containing projection rows requires native equality of those rows", () => {
  using fixture = createDispositionFixture(false);
  initializeSqliteDatabase(fixture.db, (db) => db.run("DELETE FROM bus_event"));
  fixture.db.run("INSERT INTO reply_grant VALUES ('grant', '{}', 'rule', 'actor', 'surface', 100)");
  fixture.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(fixture.path, fixture.archive);
  using archived = new Database(fixture.archive, { readwrite: true, safeIntegers: true });
  expect(() => assertArchiveEquality(fixture.db, archived, true)).not.toThrow();

  fixture.db.run("UPDATE reply_grant SET data = '{\"changed\":true}'");

  expect(() => assertArchiveEquality(fixture.db, archived, true)).toThrow(
    "stale_archive:reply_grant",
  );
});
