// #510 — exact producer manifest for the clean ledger baseline.
//
// The issue requires "exact producer manifests": an enumerated, executable
// record of WHICH code paths may write WHICH decision-class streams and
// durable legacy tables. This is the static half of the same mechanism as
// the FROZEN_TABLES archive manifest (#510 D2a / #548 / D2b): the manifest
// is the contract, and script/conformance/ledger-producer-drift.test.ts scans
// the production source tree and fails closed when the observed write
// surface diverges from the manifest in EITHER direction — a producer that
// disappears is as much a drift as an unlisted new writer.
//
// Guarantee (honest bound): this is a DRIFT GATE over the write shapes
// below, not a sandbox. After comment-stripping and whitespace
// normalization it catches, case-insensitively and across line breaks:
//   - every direct or indirect reference to `<anything>ledger.append` /
//     `.adoptStream` — dot OR bracket access, calls, `.bind`, assignment, and
//     destructuring. A rebound method therefore still identifies its source
//     module as a producer;
//   - raw SQL writes — INSERT [OR REPLACE|OR IGNORE|OR ...] INTO,
//     REPLACE INTO, UPDATE [OR ...], DELETE FROM — against
//     ledger_event/ledger_head and the frozen legacy tables, in .ts source
//     AND in runtime-executed migration .sql files.
// Dynamically assembled SQL/table names remain outside lexical discovery;
// production adapters keep table names as static SQL so the SQL half stays
// inspectable. Red-proof conformance cases pin the indirect call forms.
//
// Four write surfaces are manifested:
//   - streams: the ONE producer module per decision-class stream family
//     (`wait:` / `work:` / `route:`).
//   - appendCore: the modules allowed to touch `ledger_event`/`ledger_head`
//     rows directly (raw prepared statements) plus the storage-adapter
//     binding that exposes them as the ledger sub-adapter.
//   - sharedAppendExecutor: the ONE module that may perform the append on a
//     manifested producer's behalf. A stream family's `producers` entry still
//     names who OWNS that family's facts (payload, adoption genesis, conflict
//     taxonomy). Delegating the mechanics does NOT exempt a caller from the
//     write manifest: the scan matches the executor's entry points
//     (COMMIT_EXECUTOR_ENTRIES) as well as direct `ledger.append` calls, so a
//     module cannot launder an unmanifested stream class through the shared
//     executor. The executor itself is the only module allowed to appear in
//     the scan without owning a stream family.
//   - frozenTableWriters: the sqlite adapter modules that still CONTAIN
//     write SQL against frozen legacy tables. Their store layers throw the
//     typed frozen errors (`worker_run_frozen` — pinned by conformance), so
//     the SQL is reachable only by seeding archived fixtures at the adapter
//     layer; no OTHER module may carry write SQL for a frozen table.
//   - migrationSqlWriters: the enumerated migration .sql files allowed to
//     carry write SQL against those tables (historical, pre-freeze
//     backfills executed by the migration runner).

import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import ts from "typescript";

interface LedgerStreamProducer {
  /** Stream class key owned by this producer manifest. */
  readonly streamClass:
    | "wait"
    | "work"
    | "route"
    | "route_correction"
    | "gateway_send"
    | "approval";
  /**
   * Repo-relative paths of the enumerated modules that append this class's facts.
   */
  readonly producers: readonly string[];
  /** Which ledger write APIs the producers use. */
  readonly writes: "append" | "append+adoptStream";
}

export interface LedgerProducerManifest {
  readonly streams: readonly LedgerStreamProducer[];
  /** Modules allowed to write `ledger_event`/`ledger_head` rows directly, plus the sub-adapter binding. */
  readonly appendCore: readonly string[];
  /**
   * The single module that executes appends on manifested producers' behalf
   * (shared commit sequencing). Fact ownership stays with `streams`.
   */
  readonly sharedAppendExecutor: string;
  /** Frozen legacy tables and the ONLY modules still containing write SQL for them. */
  readonly frozenTableWriters: readonly { table: string; adapter: string }[];
  /** Migration .sql files allowed to carry write SQL against manifested tables. */
  readonly migrationSqlWriters: readonly { file: string; table: string }[];
}

export const LEDGER_PRODUCER_MANIFEST: LedgerProducerManifest = {
  streams: [
    {
      streamClass: "wait",
      producers: ["packages/ledger/src/wait/index.ts"],
      writes: "append+adoptStream",
    },
    {
      streamClass: "route",
      // The gateway router records channel-admitted route decisions before
      // anything acts. The removed product kernel's internal arm is gone.
      producers: ["packages/channels/src/router/routing-resolution.ts"],
      writes: "append",
    },
    {
      // batch ② commit 4 — the route.decided ledger-lie correction. A routed
      // wait-correlated delivery rejected fail-closed at the wait fold records
      // route.not_delivered on the separate route_correction stream. Sole
      // producer: the gateway router's wait execution (external arm only —
      // the brain's internal path retires wait correlation).
      streamClass: "route_correction",
      producers: ["packages/channels/src/router/routing-execution.ts"],
      writes: "append",
    },
    {
      // #P3 approval (docs/conversation-and-message-io.md §6) — one producer:
      // the ledger ApprovalStore (append-before-CAS, no adoption path — the
      // stream class is born with the table).
      streamClass: "approval",
      producers: ["packages/ledger/src/approval/index.ts"],
      writes: "append",
    },
    {
      // Todo 21: one durable admission per outbound message id. Retries read
      // this single-fact stream before resuming debit/wait/delivery state.
      streamClass: "gateway_send",
      producers: ["packages/channels/src/router/messaging/send.ts"],
      writes: "append",
    },
  ],
  appendCore: [
    // Raw prepared-statement writers of ledger_event/ledger_head:
    "packages/ledger/src/ledger-core/append.ts",
    "packages/ledger/src/ledger-core/adopt.ts",
    // The storage adapter binding that exposes them as `Storage.ledger`:
    "packages/ledger/src/storage/sqlite-storage.ts",
  ],
  // Decision-class commit sequencing (append at expectedHead → pre-cutover
  // adoption → projection compare-and-set, in one transaction) has one owner.
  // The wait/work producers below supply their own facts, adoption
  // genesis, and conflict taxonomy through it.
  sharedAppendExecutor: "packages/ledger/src/storage/commit-coordinator.ts",
  frozenTableWriters: [
    {
      table: "worker_run_state",
      adapter: "packages/ledger/src/storage/sqlite-worker-run-state-adapter.ts",
    },
  ],
  migrationSqlWriters: [
    // Pre-freeze historical backfill: sets executor_kind on then-live rows.
    {
      file: "packages/ledger/migration/0005_worker_run_executor_kind/migration.sql",
      table: "worker_run_state",
    },
  ],
};

/** Production source files scanned by the gate: packages/apps src trees, tests excluded. */
const SOURCE_GLOB = new Glob("{packages,apps}/*/src/**/*.{ts,tsx}");
/** Runtime-executed migration SQL (the migration runner applies these on boot). */
const MIGRATION_SQL_GLOB = new Glob("packages/*/migration/**/*.sql");

const LEDGER_TABLES = ["ledger_event", "ledger_head"] as const;
const FROZEN_TABLES = ["worker_run_state"] as const;

// Receiver ending in "ledger" + dot/bracket access to append|adoptStream,
// OR adoptStream under any receiver. No opening-call parenthesis is required:
// assignment and `.bind` are write capabilities and must identify the module.
const LEDGER_WRITE_REFERENCE =
  /[\w$]*ledger!?\s*(?:\??\.\s*(?:append|adoptStream)\b|\??\.?\s*\[\s*(?:["'](?:append|adoptStream)["']|`(?:append|adoptStream)`)\s*\])|[\w$)\]]\s*(?:\??\.\s*adoptStream\b|\??\.?\s*\[\s*(?:["']adoptStream["']|`adoptStream`)\s*\])/i;
const LEDGER_WRITE_DESTRUCTURE =
  /\{[^}]*\badoptStream\b[^}]*\}\s*=|\{[^}]*\bappend\b[^}]*\}\s*=\s*(?:[\w$]*ledger\b|[^;\n]*\.ledger\b)/i;
const LEDGER_CORE_FACADE = "packages/ledger/src/ledger-core/index.ts";

/**
 * Entry points of the shared commit executor. Calling one of these IS a
 * decision-class write — the executor performs the append on the caller's
 * behalf — so a caller must be manifested exactly like a direct appender.
 * Without this, moving the mechanics behind a helper would silently turn the
 * append surface into a blind spot.
 */
const COMMIT_EXECUTOR_ENTRIES = ["commitFact"] as const;

// Invocation, aliasing, `.bind`, destructuring, and bracket access — the same
// capability shapes LEDGER_WRITE_REFERENCE already covers for `append`.
const COMMIT_EXECUTOR_REFERENCE = new RegExp(
  `\\b(?:${COMMIT_EXECUTOR_ENTRIES.join("|")})\\b\\s*(?:\\(|\\.bind\\b|[,;)\\]}=]|$)`,
  "i",
);
const COMMIT_EXECUTOR_ACCESS = new RegExp(
  `\\[\\s*(?:["'](?:${COMMIT_EXECUTOR_ENTRIES.join("|")})["']|\`(?:${COMMIT_EXECUTOR_ENTRIES.join("|")})\`)\\s*\\]`,
  "i",
);
/** The executor module itself defines these names; it is manifested separately. */
const COMMIT_EXECUTOR_MODULE = "packages/ledger/src/storage/commit-coordinator.ts";

function tableWriteSqlPattern(tables: readonly string[]): RegExp {
  const table = `(?:${tables.join("|")})`;
  const identifier = '(?:[\\w$]+|"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|\'(?:[^\']|\'\')+\')';
  const target = `(?:${table}(?![\\w$])|"${table}"|\`${table}\`|\\[${table}\\]|'${table}')`;
  return new RegExp(
    `\\b(?:insert(?:\\s+or\\s+\\w+)?\\s+into|replace\\s+into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+(?:${identifier}\\s*\\.\\s*)?${target}`,
    "i",
  );
}

const LEDGER_TABLE_WRITE_SQL = tableWriteSqlPattern(LEDGER_TABLES);
const FROZEN_TABLE_WRITE_SQL = tableWriteSqlPattern(FROZEN_TABLES);
const ANY_TABLE_WRITE_SQL = tableWriteSqlPattern([...LEDGER_TABLES, ...FROZEN_TABLES]);

/**
 * Strips comments and collapses ALL whitespace (including newlines) to
 * single spaces so multi-line SQL/call shapes match. Line comments are
 * removed only when `//` is not preceded by `:` (keeps `https://...`
 * string content from eating the rest of the line).
 */
function normalizeTsSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");
}

/** SQL files: strip `--` line comments, collapse whitespace. */
function normalizeSqlSource(source: string): string {
  return source.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
}

/**
 * Remove transparent receiver wrappers that otherwise separate a ledger
 * identifier from its property access. Repeating handles nested parentheses
 * and combinations such as `((ledger) as Ledger)` without parsing the file.
 */
function normalizeLedgerReceiverWrappers(source: string): string {
  let normalized = source;
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized
      .replace(/([\w$]*ledger)!/gi, "$1")
      .replace(/([\w$]*ledger)\s*\?\s*([.[])/gi, "$1$2")
      .replace(/\(\s*([\w$]*ledger)\s+(?:as|satisfies)\s+[^();]+?\s*\)/gi, "$1")
      .replace(/\(\s*([\w$]*ledger)!?\s*\)/gi, "$1");
  } while (normalized !== previous);
  return normalized;
}

/** True when TS source obtains or invokes a ledger append/adoptStream capability. */
export function matchesLedgerWriteCall(tsSource: string): boolean {
  const normalized = normalizeLedgerReceiverWrappers(normalizeTsSource(tsSource));
  return LEDGER_WRITE_REFERENCE.test(normalized) || LEDGER_WRITE_DESTRUCTURE.test(normalized);
}

/**
 * True when TS source obtains or invokes a shared commit-executor entry
 * ({@link COMMIT_EXECUTOR_ENTRIES}). Delegating the append does not exempt a
 * module from the write manifest.
 */
export function matchesCommitExecutorCall(tsSource: string): boolean {
  const normalized = normalizeTsSource(tsSource);
  return COMMIT_EXECUTOR_REFERENCE.test(normalized) || COMMIT_EXECUTOR_ACCESS.test(normalized);
}

/** True when TS source contains write SQL against ledger_event/ledger_head. */
export function matchesLedgerTableWriteSql(tsSource: string): boolean {
  return matchesTsSql(tsSource, LEDGER_TABLE_WRITE_SQL);
}

/** True when TS source contains write SQL against a frozen legacy table. */
export function matchesFrozenTableWriteSql(tsSource: string): boolean {
  return matchesTsSql(tsSource, FROZEN_TABLE_WRITE_SQL);
}

function matchesTsSql(source: string, pattern: RegExp): boolean {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  function visit(node: ts.Node): boolean {
    // Literal text is decoded by TypeScript, including escaped SQL quotes.
    // Template fragments stay separate: dynamically assembled names are not inferred.
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      return pattern.test(normalizeSqlSource(node.text));
    }
    return ts.forEachChild(node, visit) ?? false;
  }
  return visit(file);
}

/** True when migration SQL contains write SQL against any manifested table. */
export function matchesMigrationTableWriteSql(sqlSource: string): boolean {
  return ANY_TABLE_WRITE_SQL.test(normalizeSqlSource(sqlSource));
}

export interface LedgerProducerScan {
  /** .ts files containing a ledger append/adoptStream call shape. */
  readonly appendCallSites: readonly string[];
  /** .ts files containing write SQL against ledger_event/ledger_head. */
  readonly ledgerTableWriters: readonly string[];
  /** .ts files containing write SQL against a frozen legacy table. */
  readonly frozenTableWriters: readonly string[];
  /** Migration .sql files containing write SQL against any manifested table. */
  readonly migrationSqlWriters: readonly string[];
}

/** Scans the production source tree for every ledger/frozen-table write surface. */
export async function scanLedgerProducers(rootDir: string): Promise<LedgerProducerScan> {
  const appendCallSites: string[] = [];
  const ledgerTableWriters: string[] = [];
  const frozenTableWriters: string[] = [];
  const migrationSqlWriters: string[] = [];
  const sourceFiles = [...SOURCE_GLOB.scanSync({ cwd: rootDir })].filter(
    (file) => !/\.(?:test|spec)\.tsx?$/.test(file) && !/\/(?:test|tests|__tests__|node_modules|dist)\//.test(file),
  );
  sourceFiles.sort();
  for (const file of sourceFiles) {
    const content = await Bun.file(join(rootDir, file)).text();
    const writesDirectly = file !== LEDGER_CORE_FACADE && matchesLedgerWriteCall(content);
    // Delegating through the shared executor is the same write surface.
    const writesViaExecutor = file !== COMMIT_EXECUTOR_MODULE && matchesCommitExecutorCall(content);
    if (writesDirectly || writesViaExecutor) appendCallSites.push(file);
    if (matchesLedgerTableWriteSql(content)) ledgerTableWriters.push(file);
    if (matchesFrozenTableWriteSql(content)) frozenTableWriters.push(file);
  }
  const migrationFiles = [...MIGRATION_SQL_GLOB.scanSync({ cwd: rootDir })];
  migrationFiles.sort();
  for (const file of migrationFiles) {
    const content = await Bun.file(join(rootDir, file)).text();
    if (matchesMigrationTableWriteSql(content)) migrationSqlWriters.push(file);
  }
  return { appendCallSites, ledgerTableWriters, frozenTableWriters, migrationSqlWriters };
}

/** Live schema is supplied by the real lifecycle, never reconstructed from historical CREATEs. */
export function liveCensusTables(db: Database): { name: string; sql: string }[] {
  return db.query<{ name: string; sql: string }, []>(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND sql IS NOT NULL ORDER BY name",
  ).all();
}

/** Exact producer ownership metadata; registration and archive access confer no consumer credit. */
export function ledgerCensusRole(definition: { path: string; symbol: string }): "migration" | "archive" | "product" {
  // These are identities of the existing lifecycle/disposition entry points,
  // not filename exclusions: unrelated operations in the same file stay product.
  if (definition.path === "packages/ledger/src/storage/migration-runner.ts" && ["applyOrdered", "applyMigration"].includes(definition.symbol)) return "migration";
  if (definition.path === "packages/ledger/src/storage/u967-preflight.ts" && definition.symbol === "preflight967") return "archive";
  if (definition.path === "packages/ledger/src/storage/u967-projection.ts" && definition.symbol === "inspect967Projections") return "archive";
  if (definition.path === "packages/ledger/src/storage/sqlite-schema-lifecycle.ts" && definition.symbol === "preflightSqliteDatabase") return "archive";
  return "product";
}

/** Inventory-fed historical lineage only. Never promotes historical CREATEs
 * into live stores; the live database remains the authority for existence. */
export function ledgerCensusSchemaOrigins(sources: readonly { path: string; sql: string }[]): { family: string; path: string; line: number; dropped: boolean }[] {
  const origins = new Map<string, { family: string; path: string; line: number; dropped: boolean }>();
  for (const source of [...sources].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    for (const match of source.sql.matchAll(/\b(CREATE|DROP)\s+TABLE\s+(?:(?:IF NOT EXISTS|IF EXISTS)\s+)?["`[]?([\w]+)["`\]]?/gi)) {
      const family = match[2]; if (!family) continue;
      const dropped = match[1]?.toUpperCase() === "DROP";
      const prior = origins.get(family);
      if (prior) prior.dropped = dropped;
      else origins.set(family, { family, path: source.path, line: source.sql.slice(0, match.index).split("\n").length, dropped });
    }
  }
  return [...origins.values()];
}

/** Existing schema comparison builds only a disposable in-memory DDL model.
 * Its generated statements are schema-tool inputs, not product row consumers. */
export function ledgerCensusSchemaCompiler(definition: { path: string; symbol: string }): boolean {
  return definition.path === "script/check-ledger-schema-drift.ts" && definition.symbol === "main";
}

export function ledgerCensusOwner(table: string): readonly string[] {
  if (table === "ledger_event" || table === "ledger_head")
    return LEDGER_PRODUCER_MANIFEST.appendCore;
  return LEDGER_PRODUCER_MANIFEST.frozenTableWriters
    .filter((entry) => entry.table === table).map((entry) => entry.adapter);
}
