import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalDigest } from "../packages/protocol/src/index";
import {
  sqliteSchema,
  U967Error,
  U967_MIGRATION,
  RETIRED_TABLE_MIGRATION,
  REPLY_GRANT_MIGRATION,
} from "../packages/ledger/src/storage/u967-preflight";
import { preflightSqliteDatabase } from "../packages/ledger/src/storage/sqlite-schema-lifecycle";

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function tableColumns(db: Database, table: string) {
  using statement = db.prepare<{ name: string; pk: number }, []>(
    `SELECT name, CAST(pk AS REAL) AS pk FROM pragma_table_info(${sqlIdentifier(table)}) ORDER BY cid`,
  );
  return statement.all();
}

export function archiveTableEntries(db: Database, sourceSchemaVersion: string) {
  return sqliteSchema(db)
    .filter((row) => row.type === "table")
    .map(({ name: table }) => {
      const columns = tableColumns(db, table);
      const keys = columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      const order = [...keys.map(sqlIdentifier), "rowid"].join(", ");
      const key = sqlIdentifier(keys[0] ?? "rowid");
      // SQLite supplies its own SQL literals. This supplemental digest is not
      // the raw-equality oracle (notably quote(TEXT) stops at an embedded NUL).
      using rows = db.prepare<Record<string, string>, []>(
        `SELECT ${columns.map(({ name }) => `quote(${sqlIdentifier(name)}) AS ${sqlIdentifier(name)}`).join(", ")} FROM ${sqlIdentifier(table)} ORDER BY ${order}`,
      );
      using ids = db.prepare<{ id: string | null }, []>(
        `SELECT CAST(${key} AS TEXT) AS id FROM ${sqlIdentifier(table)} ORDER BY ${order}`,
      );
      const literals = rows.all();
      const range = ids.all();
      return {
        table,
        sourceSchemaVersion,
        columns: columns.map((column) => column.name),
        keys,
        rowCount: literals.length,
        idRange:
          range.length === 0
            ? null
            : { first: range[0]?.id ?? null, last: range.at(-1)?.id ?? null },
        integrityHash: canonicalDigest(literals),
      };
    });
}

/** Native equality for approved archive disposition; later empty-table removal loses no rows. */
export function assertArchiveEquality(
  source: Database,
  restored: Database,
  dispositionDelta = false,
): void {
  const sourceSchema = sqliteSchema(source);
  const archivedSchema = sqliteSchema(restored);
  const removedTables = new Set(dispositionDelta ? ["bus_event"] : []);
  const addedTables = new Set<string>();
  const migrationDelta: string[] = [];
  if (dispositionDelta) {
    for (const table of ["delegation", "worker_grant", "worker_run_state"]) {
      if (
        sourceSchema.some((row) => row.name === table) ||
        !archivedSchema.some((row) => row.name === table)
      )
        continue;
      using remaining = restored.prepare<{ present: number | bigint }, []>(
        `SELECT 1 AS present FROM ${sqlIdentifier(table)} LIMIT 1`,
      );
      if (remaining.get() !== null) throw new U967Error(`stale_archive:${table}`);
      removedTables.add(table);
    }
    if (
      !archivedSchema.some((row) => row.name === "reply_grant") &&
      sourceSchema.some((row) => row.name === "reply_grant")
    ) {
      // Only the pinned forward schema with an empty new projection is allowed.
      preflightSqliteDatabase(source);
      using remaining = source.prepare("SELECT 1 FROM reply_grant LIMIT 1");
      if (remaining.get() !== null) throw new U967Error("stale_archive:reply_grant");
      addedTables.add("reply_grant");
    }
    for (const name of [U967_MIGRATION, RETIRED_TABLE_MIGRATION, REPLY_GRANT_MIGRATION]) {
      using marker = restored.prepare("SELECT 1 FROM _migrations WHERE name = ?");
      if (marker.get(name) === null) migrationDelta.push(name);
    }
  }
  const expectedSchema = archivedSchema.filter((row) => !removedTables.has(row.tbl_name));
  if (
    !isDeepStrictEqual(
      sourceSchema.filter((row) => !addedTables.has(row.tbl_name)),
      expectedSchema,
    )
  )
    throw new U967Error("stale_archive");
  for (const { name: table } of expectedSchema.filter((row) => row.type === "table")) {
    const columns = tableColumns(restored, table);
    // Keep TEXT as native bytes too: invalid UTF-8 and embedded NUL may not
    // round-trip through JS strings. INTEGER stays bigint on both raw handles.
    const values = columns.flatMap(({ name }, index) => {
      const column = sqlIdentifier(name);
      return [
        `typeof(${column}) AS t${index}`,
        `CASE WHEN typeof(${column}) = 'text' THEN CAST(${column} AS BLOB) ELSE ${column} END AS v${index}`,
      ];
    });
    const read = (db: Database, archived: boolean) => {
      let where = "";
      if (dispositionDelta && archived && table === "wait") where = " WHERE owner_kind = 'session'";
      if (dispositionDelta && archived && table === "sqlite_sequence")
        where = " WHERE name <> 'bus_event'";
      if (dispositionDelta && table === "_migrations" && !archived && migrationDelta.length > 0) {
        where = ` WHERE name NOT IN (${migrationDelta.map((name) => `'${name}'`).join(", ")})`;
      }
      using statement = db.prepare<
        Record<string, string | number | bigint | Uint8Array | null>,
        []
      >(`SELECT rowid, ${values.join(", ")} FROM ${sqlIdentifier(table)}${where} ORDER BY rowid`);
      return statement.all();
    };
    if (!isDeepStrictEqual(read(source, false), read(restored, true)))
      throw new U967Error(`stale_archive:${table}`);
  }
}

export function withRestoredArchive<T>(
  archive: string,
  hash: string,
  inspect: (db: Database) => T,
): T {
  if (fileSha256(archive) !== hash) throw new U967Error("digest_mismatch");
  const directory = mkdtempSync(join(tmpdir(), "openomni-967-restore-"));
  const copy = join(directory, "restore.sqlite");
  try {
    copyFileSync(archive, copy, constants.COPYFILE_EXCL);
    if (fileSha256(copy) !== hash) throw new U967Error("digest_mismatch");
    const db = new Database(copy, { readwrite: true, safeIntegers: true });
    using _restoration = {
      [Symbol.dispose]() {
        db.close(true);
        if (fileSha256(copy) !== hash || fileSha256(archive) !== hash)
          throw new U967Error("digest_mismatch");
      },
    };
    {
      const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
      if (
        !isDeepStrictEqual(integrity, [{ integrity_check: "ok" }]) ||
        db.query("PRAGMA foreign_key_check").all().length > 0
      ) {
        throw new U967Error("invalid_archive");
      }
      return inspect(db);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}
