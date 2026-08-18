/**
 * Ledger DDL drift gate (#552 item 4). packages/ledger/src/ledger-core/
 * schema.ts is the DDL source of truth and the hand-written migration SQL is
 * the applied truth (blueprint "Storage decisions", drizzle.config.ts); this
 * check fails when the two would produce different SQLite schemas for the
 * tables drizzle defines.
 *
 * Method: apply the real migration chain to one in-memory database (via the
 * production lifecycle runner) and drizzle-kit's generated DDL for schema.ts
 * to another, then compare the introspected shape — columns, declared types,
 * NOT NULL, primary keys, unique indexes — of every drizzle-defined table.
 *
 * Normalization: a declared PRIMARY KEY column counts as NOT NULL on both
 * sides. SQLite's legacy quirk leaves non-INTEGER pk columns nullable unless
 * spelled out; drizzle always spells it out, while the applied hand SQL
 * predates this gate and applied migrations are immutable.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ledgerDir = join(root, "packages", "ledger");

// drizzle-kit is a devDependency of @openomni/ledger; under bun's isolated
// linker it is only resolvable from that package, not from root scripts.
const drizzleKitApi = (await import(Bun.resolveSync("drizzle-kit/api", ledgerDir))) as {
  generateSQLiteDrizzleJson: (
    imports: Record<string, unknown>,
    prevId?: string,
    casing?: "snake_case" | "camelCase",
  ) => Promise<{ id: string }>;
  generateSQLiteMigration: (prev: { id: string }, cur: { id: string }) => Promise<string[]>;
};
const schema = (await import(join(ledgerDir, "src", "ledger-core", "schema.ts"))) as Record<
  string,
  unknown
>;
const { initializeSqliteDatabase } = (await import(
  join(ledgerDir, "src", "storage", "sqlite-schema-lifecycle.ts")
)) as { initializeSqliteDatabase: (db: Database) => void };

type ColumnShape = {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyOrdinal: number;
};

type TableShape = {
  columns: ColumnShape[];
  uniqueIndexes: string[][];
};

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type IndexListRow = { name: string; unique: number; origin: string };

function tableShape(db: Database, table: string): TableShape {
  const columns = (db.query(`PRAGMA table_info("${table}")`).all() as TableInfoRow[]).map(
    (row) => ({
      name: row.name,
      type: row.type.toUpperCase(),
      // pk implies NOT NULL on both sides — see header normalization note.
      notNull: row.notnull !== 0 || row.pk > 0,
      defaultValue: row.dflt_value ?? null,
      primaryKeyOrdinal: row.pk,
    }),
  );
  const uniqueIndexes = (db.query(`PRAGMA index_list("${table}")`).all() as IndexListRow[])
    .filter((index) => index.unique !== 0 && index.origin !== "pk")
    .map((index) =>
      (db.query(`PRAGMA index_info("${index.name}")`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    )
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
  return { columns, uniqueIndexes };
}

function tableNames(db: Database): string[] {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

// Applied truth: the full hand-written migration chain via the real runner.
const migrated = new Database(":memory:");
initializeSqliteDatabase(migrated);

// DDL source of truth: drizzle-kit's generated statements for schema.ts.
const generated = new Database(":memory:");
const emptySnapshot = await drizzleKitApi.generateSQLiteDrizzleJson({}, undefined, "snake_case");
const currentSnapshot = await drizzleKitApi.generateSQLiteDrizzleJson(
  schema,
  emptySnapshot.id,
  "snake_case",
);
for (const statement of await drizzleKitApi.generateSQLiteMigration(
  emptySnapshot,
  currentSnapshot,
)) {
  generated.exec(statement);
}

const drizzleTables = tableNames(generated).sort();
if (drizzleTables.length === 0) {
  console.error("DRIFT: drizzle schema.ts defines no tables — the gate has nothing to check");
  process.exit(1);
}

const migratedTables = new Set(tableNames(migrated));
const failures: string[] = [];
for (const table of drizzleTables) {
  if (!migratedTables.has(table)) {
    failures.push(`DRIFT: table ${table} exists in schema.ts but no applied migration creates it`);
    continue;
  }
  const expected = JSON.stringify(tableShape(generated, table), null, 2);
  const actual = JSON.stringify(tableShape(migrated, table), null, 2);
  if (expected !== actual) {
    failures.push(
      `DRIFT: table ${table} — schema.ts (drizzle) and applied migration SQL disagree\n` +
        `--- schema.ts would create:\n${expected}\n--- applied migrations create:\n${actual}`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  console.error(
    "\nschema.ts is the DDL source of truth and hand SQL is the applied truth — reconcile them (new migration or schema fix), never rewrite an applied migration.",
  );
  process.exit(1);
}

console.log(
  `OK: ledger DDL drift check — ${drizzleTables.length} table(s) match between schema.ts and applied migrations (${drizzleTables.join(", ")})`,
);
