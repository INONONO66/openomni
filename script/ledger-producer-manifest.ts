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
//     (`wait:` / `work:` / `route:` / `command:` — the class
//     vocabulary is protocol `Ledger.StreamRegistry`). A retained protocol
//     class may have zero producers after its owning product path is removed.
//   - appendCore: the modules allowed to touch `ledger_event`/`ledger_head`
//     rows directly (raw prepared statements) plus the storage-adapter
//     binding that exposes them as the ledger sub-adapter.
//   - frozenTableWriters: the sqlite adapter modules that still CONTAIN
//     write SQL against frozen legacy tables. Their store layers throw the
//     typed frozen errors (`pending_ask_frozen` / `pending_interaction`
//     freeze / `worker_run_frozen` — pinned by conformance), so the SQL is
//     reachable only by seeding archived fixtures at the adapter layer; no
//     OTHER module may carry write SQL for a frozen table.
//   - migrationSqlWriters: the enumerated migration .sql files allowed to
//     carry write SQL against those tables (historical, pre-freeze
//     backfills executed by the migration runner).

import { Glob } from "bun";
import { join } from "node:path";

interface LedgerStreamProducer {
  /** Stream class key — must match `Ledger.StreamRegistry`. */
  readonly streamClass:
    | "wait"
    | "work"
    | "route"
    | "route_correction"
    | "command"
    | "engagement"
    | "gateway_send";
  /**
   * Repo-relative paths of the enumerated modules that append this class's
   * facts. A retained protocol class may have no current producer.
   */
  readonly producers: readonly string[];
  /** Which ledger write APIs the producers use. */
  readonly writes: "append" | "append+adoptStream";
}

export interface LedgerProducerManifest {
  readonly streams: readonly LedgerStreamProducer[];
  /** Modules allowed to write `ledger_event`/`ledger_head` rows directly, plus the sub-adapter binding. */
  readonly appendCore: readonly string[];
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
      streamClass: "work",
      producers: ["packages/ledger/src/work-item/facts.ts"],
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
      // Contract retained for compatibility; its legacy dispatch producer
      // was removed with the old product kernel.
      streamClass: "command",
      producers: [],
      writes: "append",
    },
    {
      // #709 engagement machine (gateway-design §5) — brain-domain surface,
      // one producer: the ledger EngagementStore (append-before-CAS, no
      // adoption path — the stream class is born with the table).
      streamClass: "engagement",
      producers: ["packages/ledger/src/engagement/index.ts"],
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
  frozenTableWriters: [
    { table: "pending_ask", adapter: "packages/ledger/src/storage/sqlite-pending-ask-adapter.ts" },
    {
      table: "pending_interaction",
      adapter: "packages/ledger/src/storage/sqlite-pending-interaction-adapter.ts",
    },
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
const SOURCE_GLOB = new Glob("{packages,apps}/*/src/**/*.ts");
/** Runtime-executed migration SQL (the migration runner applies these on boot). */
const MIGRATION_SQL_GLOB = new Glob("packages/*/migration/**/*.sql");

const LEDGER_TABLES = ["ledger_event", "ledger_head"] as const;
const FROZEN_TABLES = ["pending_ask", "pending_interaction", "worker_run_state"] as const;

// Receiver ending in "ledger" + dot/bracket access to append|adoptStream,
// OR adoptStream under any receiver. No opening-call parenthesis is required:
// assignment and `.bind` are write capabilities and must identify the module.
const LEDGER_WRITE_REFERENCE =
  /[\w$]*ledger\s*(?:\.\s*(?:append|adoptStream)\b|\[\s*["'](?:append|adoptStream)["']\s*\])|[\w$)\]]\s*(?:\.\s*adoptStream\b|\[\s*["']adoptStream["']\s*\])/i;
const LEDGER_WRITE_DESTRUCTURE =
  /\{[^}]*\badoptStream\b[^}]*\}\s*=|\{[^}]*\bappend\b[^}]*\}\s*=\s*(?:[\w$]*ledger\b|[^;\n]*\.ledger\b)/i;
const LEDGER_CORE_FACADE = "packages/ledger/src/ledger-core/index.ts";

function tableWriteSqlPattern(tables: readonly string[]): RegExp {
  const table = `(?:${tables.join("|")})`;
  return new RegExp(
    `\\b(?:insert(?:\\s+or\\s+\\w+)?\\s+into|replace\\s+into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+${table}\\b`,
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

/** True when TS source obtains or invokes a ledger append/adoptStream capability. */
export function matchesLedgerWriteCall(tsSource: string): boolean {
  const normalized = normalizeTsSource(tsSource);
  return LEDGER_WRITE_REFERENCE.test(normalized) || LEDGER_WRITE_DESTRUCTURE.test(normalized);
}

/** True when TS source contains write SQL against ledger_event/ledger_head. */
export function matchesLedgerTableWriteSql(tsSource: string): boolean {
  return LEDGER_TABLE_WRITE_SQL.test(normalizeTsSource(tsSource));
}

/** True when TS source contains write SQL against a frozen legacy table. */
export function matchesFrozenTableWriteSql(tsSource: string): boolean {
  return FROZEN_TABLE_WRITE_SQL.test(normalizeTsSource(tsSource));
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
    (file) => !file.endsWith(".test.ts"),
  );
  sourceFiles.sort();
  for (const file of sourceFiles) {
    const content = await Bun.file(join(rootDir, file)).text();
    if (file !== LEDGER_CORE_FACADE && matchesLedgerWriteCall(content)) appendCallSites.push(file);
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
