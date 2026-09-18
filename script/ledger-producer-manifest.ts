// Exact producers of first-writer-wins decision facts. This lexical drift gate
// covers direct/aliased record capabilities, SQL writes and historical backfills.
// Dynamically assembled SQL identifiers are outside lexical discovery.
import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import ts from "typescript";

interface LedgerStreamProducer {
  readonly streamClass: "route" | "route_correction" | "gateway_send";
  readonly producers: readonly string[];
  readonly writes: "record";
}

export interface LedgerProducerManifest {
  readonly streams: readonly LedgerStreamProducer[];
  readonly recordCore: readonly string[];
  readonly frozenTableWriters: readonly { table: string; adapter: string }[];
  readonly migrationSqlWriters: readonly { file: string; table: string }[];
}

export const LEDGER_PRODUCER_MANIFEST: LedgerProducerManifest = {
  streams: [
    {
      streamClass: "route",
      producers: ["packages/channels/src/router/route-record.ts"],
      writes: "record",
    },
    {
      streamClass: "route_correction",
      producers: ["packages/channels/src/router/routing-execution.ts"],
      writes: "record",
    },
    {
      streamClass: "gateway_send",
      producers: ["packages/channels/src/router/messaging/admission.ts"],
      writes: "record",
    },
  ],
  recordCore: [
    "packages/ledger/src/storage/sqlite-decision-facts.ts",
    "packages/ledger/src/storage/decision-fact-migration.ts",
    "packages/ledger/src/storage/sqlite-storage.ts",
  ],
  frozenTableWriters: [],
  migrationSqlWriters: [
    {
      file: "packages/ledger/migration/0005_worker_run_executor_kind/migration.sql",
      table: "worker_run_state",
    },
  ],
};

const SOURCE_GLOB = new Glob("{packages,apps}/*/src/**/*.{ts,tsx}");
const MIGRATION_SQL_GLOB = new Glob("packages/*/migration/**/*.sql");
const DECISION_TABLES = ["decision_fact"] as const;
const FROZEN_TABLES = ["worker_run_state"] as const;
const RECORD_REFERENCE =
  /[\w$]*decisionFacts!?\s*(?:\??\.\s*record\b|\??\.?\s*\[\s*(?:["']record["']|`record`)\s*\])/i;
const RECORD_DESTRUCTURE =
  /\{[^}]*\brecord\b[^}]*\}\s*=\s*(?:[\w$]*decisionFacts\b|[^;\n]*\.decisionFacts\b)/i;
const STORAGE_BINDING = /\bcreateSqliteDecisionFacts\s*\(/;
const COMMIT_EXECUTOR_REFERENCE = /\bcommitFact\b\s*(?:\(|\.bind\b|[,;)\]}=]|$)/i;
const COMMIT_EXECUTOR_ACCESS = /\[\s*(?:["']commitFact["']|`commitFact`)\s*\]/i;

function tableWriteSqlPattern(tables: readonly string[]): RegExp {
  const table = `(?:${tables.join("|")})`;
  const identifier = "(?:[\\w$]+|\"(?:[^\"]|\"\")+\"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|'(?:[^']|'')+')";
  const target = `(?:${table}(?![\\w$])|"${table}"|\`${table}\`|\\[${table}\\]|'${table}')`;
  return new RegExp(
    `\\b(?:insert(?:\\s+or\\s+\\w+)?\\s+into|replace\\s+into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+(?:${identifier}\\s*\\.\\s*)?${target}`,
    "i",
  );
}

const DECISION_TABLE_WRITE_SQL = tableWriteSqlPattern(DECISION_TABLES);
const FROZEN_TABLE_WRITE_SQL = tableWriteSqlPattern(FROZEN_TABLES);
const ANY_TABLE_WRITE_SQL = tableWriteSqlPattern([...DECISION_TABLES, ...FROZEN_TABLES]);

function normalizeTsSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");
}

function normalizeSqlSource(source: string): string {
  return source.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
}

function normalizeDecisionReceiverWrappers(source: string): string {
  let normalized = source;
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized
      .replace(/([\w$]*decisionFacts)!/gi, "$1")
      .replace(/([\w$]*decisionFacts)\s*\?\s*([.[])/gi, "$1$2")
      .replace(/\(\s*([\w$]*decisionFacts)\s+(?:as|satisfies)\s+[^();]+?\s*\)/gi, "$1")
      .replace(/\(\s*([\w$]*decisionFacts)!?\s*\)/gi, "$1");
  } while (normalized !== previous);
  return normalized;
}

/** Record calls, aliases, destructuring, and the storage binding are capabilities. */
export function matchesLedgerWriteCall(tsSource: string): boolean {
  const normalized = normalizeDecisionReceiverWrappers(normalizeTsSource(tsSource));
  return RECORD_REFERENCE.test(normalized) || RECORD_DESTRUCTURE.test(normalized);
}

/** A reintroduced shared write executor must not bypass the producer census. */
export function matchesCommitExecutorCall(tsSource: string): boolean {
  const normalized = normalizeTsSource(tsSource);
  return COMMIT_EXECUTOR_REFERENCE.test(normalized) || COMMIT_EXECUTOR_ACCESS.test(normalized);
}

export function matchesLedgerTableWriteSql(tsSource: string): boolean {
  return matchesTsSql(tsSource, DECISION_TABLE_WRITE_SQL);
}

export function matchesFrozenTableWriteSql(tsSource: string): boolean {
  return matchesTsSql(tsSource, FROZEN_TABLE_WRITE_SQL);
}

function matchesTsSql(source: string, pattern: RegExp): boolean {
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  function visit(node: ts.Node): boolean {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      return pattern.test(normalizeSqlSource(node.text));
    }
    return ts.forEachChild(node, visit) ?? false;
  }
  return visit(file);
}

export function matchesMigrationTableWriteSql(sqlSource: string): boolean {
  return ANY_TABLE_WRITE_SQL.test(normalizeSqlSource(sqlSource));
}

export interface LedgerProducerScan {
  readonly recordCallSites: readonly string[];
  readonly decisionTableWriters: readonly string[];
  readonly frozenTableWriters: readonly string[];
  readonly migrationSqlWriters: readonly string[];
}

export async function scanLedgerProducers(rootDir: string): Promise<LedgerProducerScan> {
  const recordCallSites: string[] = [];
  const decisionTableWriters: string[] = [];
  const frozenTableWriters: string[] = [];
  const migrationSqlWriters: string[] = [];
  const sourceFiles = [...SOURCE_GLOB.scanSync({ cwd: rootDir })].filter(
    (file) =>
      !/\.(?:test|spec)\.tsx?$/.test(file) &&
      !/\/(?:test|tests|__tests__|node_modules|dist)\//.test(file),
  );
  sourceFiles.sort();
  for (const file of sourceFiles) {
    const content = await Bun.file(join(rootDir, file)).text();
    const binding =
      STORAGE_BINDING.test(normalizeTsSource(content)) &&
      !/\bfunction\s+createSqliteDecisionFacts\b/.test(content);
    if (matchesLedgerWriteCall(content) || matchesCommitExecutorCall(content) || binding)
      recordCallSites.push(file);
    if (matchesLedgerTableWriteSql(content)) decisionTableWriters.push(file);
    if (matchesFrozenTableWriteSql(content)) frozenTableWriters.push(file);
  }
  const migrationFiles = [...MIGRATION_SQL_GLOB.scanSync({ cwd: rootDir })].sort();
  for (const file of migrationFiles) {
    const content = await Bun.file(join(rootDir, file)).text();
    if (matchesMigrationTableWriteSql(content)) migrationSqlWriters.push(file);
  }
  return { recordCallSites, decisionTableWriters, frozenTableWriters, migrationSqlWriters };
}

export function liveCensusTables(db: Database): { name: string; sql: string }[] {
  return db
    .query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND sql IS NOT NULL ORDER BY name",
    )
    .all();
}

export function ledgerCensusRole(definition: {
  path: string;
  symbol: string;
}): "migration" | "archive" | "product" {
  if (
    definition.path === "packages/ledger/src/storage/migration-runner.ts" &&
    ["applyOrdered", "applyMigration"].includes(definition.symbol)
  )
    return "migration";
  if (
    definition.path === "packages/ledger/src/storage/decision-fact-migration.ts" &&
    definition.symbol === "migrateDecisionFacts"
  )
    return "migration";
  if (
    definition.path === "packages/ledger/src/storage/u967-preflight.ts" &&
    definition.symbol === "preflight967"
  )
    return "archive";
  if (
    definition.path === "packages/ledger/src/storage/u967-projection.ts" &&
    definition.symbol === "inspect967Projections"
  )
    return "archive";
  if (
    definition.path === "packages/ledger/src/storage/sqlite-schema-lifecycle.ts" &&
    definition.symbol === "preflightSqliteDatabase"
  )
    return "archive";
  return "product";
}

export function ledgerCensusSchemaOrigins(
  sources: readonly { path: string; sql: string }[],
): { family: string; path: string; line: number; dropped: boolean }[] {
  const origins = new Map<
    string,
    { family: string; path: string; line: number; dropped: boolean }
  >();
  for (const source of [...sources].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  )) {
    for (const match of source.sql.matchAll(
      /\b(CREATE|DROP)\s+TABLE\s+(?:(?:IF NOT EXISTS|IF EXISTS)\s+)?["`[]?([\w]+)["`\]]?/gi,
    )) {
      const family = match[2];
      if (!family) continue;
      const dropped = match[1]?.toUpperCase() === "DROP";
      const prior = origins.get(family);
      if (prior) prior.dropped = dropped;
      else
        origins.set(family, {
          family,
          path: source.path,
          line: source.sql.slice(0, match.index).split("\n").length,
          dropped,
        });
    }
  }
  return [...origins.values()];
}

export function ledgerCensusSchemaCompiler(definition: { path: string; symbol: string }): boolean {
  return definition.path === "script/check-ledger-schema-drift.ts" && definition.symbol === "main";
}

export function ledgerCensusOwner(table: string): readonly string[] {
  if (table === "decision_fact") return LEDGER_PRODUCER_MANIFEST.recordCore;
  return LEDGER_PRODUCER_MANIFEST.frozenTableWriters
    .filter((entry) => entry.table === table)
    .map((entry) => entry.adapter);
}
