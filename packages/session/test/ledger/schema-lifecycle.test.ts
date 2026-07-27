import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Migration } from "../../src/storage/migration-runner";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  return undefined;
});

describe("P2 clean schema lifecycle", () => {
  test("initializes an empty file atomically and applies writer pragmas", () => {
    const { path } = databasePath();
    writeFileSync(path, "");
    const db = new Database(path, { strict: true });

    initializeSqliteDatabase(db);

    expect(pragmaValue(db, "journal_mode")).toBe("wal");
    expect(pragmaValue(db, "synchronous")).toBe(2);
    expect(pragmaValue(db, "foreign_keys")).toBe(1);
    expect(pragmaValue(db, "busy_timeout")).toBe(5_000);
    expect(db.query("SELECT baseline_id, schema_version FROM schema_meta").get()).toEqual({
      baseline_id: "p2-clean-v1",
      schema_version: 1,
    });
    db.close();
  });

  test("reopens only an exact recognized baseline without reapplying it", () => {
    const { path } = databasePath();
    const first = new Database(path, { strict: true });
    initializeSqliteDatabase(first);
    const appliedAt = first.query("SELECT applied_at_db_ms FROM _migrations").get() as {
      readonly applied_at_db_ms: number;
    };
    first.close();

    const reopened = new Database(path, { strict: true });
    initializeSqliteDatabase(reopened);
    expect(reopened.query("SELECT applied_at_db_ms FROM _migrations").get()).toEqual(appliedAt);
    expect(pragmaValue(reopened, "synchronous")).toBe(2);
    reopened.close();
  });

  test("refuses a legacy schema with the exact guidance and no mutation or sidecar", () => {
    const { path } = databasePath();
    const legacy = new Database(path, { strict: true });
    legacy.exec("CREATE TABLE session (id TEXT PRIMARY KEY) STRICT");
    legacy.close();
    const before = readFileSync(path);

    const db = new Database(path, { strict: true });
    const expected = `Unsupported database schema at "${resolve(path)}".\nOpenOmni P2 clean baseline "p2-clean-v1" does not migrate existing databases.\nStop OpenOmni, delete "${resolve(path)}", "${resolve(path)}-wal", and "${resolve(path)}-shm", then restart to initialize a new database.`;
    expect(() => initializeSqliteDatabase(db)).toThrow(expected);
    expect(pragmaValue(db, "journal_mode")).toBe("delete");
    db.close();

    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  test("refuses a perturbed baseline instead of interpreting it as legacy", () => {
    const { path } = databasePath();
    const created = new Database(path, { strict: true });
    initializeSqliteDatabase(created);
    created.exec("PRAGMA journal_mode = DELETE");
    created.exec("DROP INDEX message_projection_session_idx");
    created.close();
    const before = readFileSync(path);

    const reopened = new Database(path, { strict: true });
    expect(() => initializeSqliteDatabase(reopened)).toThrow(
      'OpenOmni P2 clean baseline "p2-clean-v1" does not migrate existing databases.',
    );
    reopened.close();
    expect(readFileSync(path)).toEqual(before);
  });

  test("rolls back every baseline object when the single migration fails", () => {
    const root = mkdtempSync(join(tmpdir(), "openomni-broken-baseline-"));
    roots.push(root);
    const migrationDir = join(root, "migration");
    const baselineDir = join(migrationDir, "0001_p2_clean_baseline");
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(
      join(baselineDir, "migration.sql"),
      "CREATE TABLE partial_object (id TEXT PRIMARY KEY) STRICT; INVALID SQL;",
    );
    const db = new Database(join(root, "ledger.sqlite"), { strict: true });

    expect(() =>
      Migration.applyBaseline(db, migrationDir, { name: Migration.BASELINE_NAME }),
    ).toThrow();
    expect(db.query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()).toEqual(
      [],
    );
    db.close();
  });
});

function databasePath(): { readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), "openomni-schema-lifecycle-"));
  roots.push(root);
  return { path: join(root, "ledger.sqlite") };
}

function pragmaValue(db: Database, pragma: string): string | number {
  const row = db.query(`PRAGMA ${pragma}`).get() as Record<string, string | number> | null;
  if (row === null) throw new Error(`Expected PRAGMA ${pragma} to return a row`);
  const value = Object.values(row)[0];
  if (value === undefined) throw new Error(`Expected PRAGMA ${pragma} row to contain a value`);
  return value;
}
