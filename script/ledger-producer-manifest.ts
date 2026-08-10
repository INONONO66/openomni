// #510 — exact producer manifest for the clean ledger baseline.
//
// The issue requires "exact producer manifests": an enumerated, executable
// record of WHICH code paths may write WHICH decision-class streams and
// durable legacy tables. This is the static half of the same mechanism as
// the FROZEN_TABLES archive manifest (#510 D2a / #548 / D2b): the manifest
// is the contract, and script/conformance/p2-ledger-baseline.test.ts scans
// the production source tree and fails closed when the observed write
// surface diverges from the manifest in EITHER direction — a producer that
// disappears is as much a drift as an unlisted new writer.
//
// Three write surfaces are manifested:
//   - streams: the ONE producer module per decision-class stream family
//     (`wait:` / `work:` / `route:` / `command:` / `effect:` — the class
//     vocabulary is protocol `LedgerAppend.StreamRegistry`); every
//     `ledger.append(...)`/`ledger.adoptStream(...)` call site must live in
//     a manifested producer or the append-core binding.
//   - appendCore: the modules allowed to touch `ledger_event`/`ledger_head`
//     rows directly (raw prepared statements) plus the storage-adapter
//     binding that exposes them as the ledger sub-adapter.
//   - frozenTableWriters: the sqlite adapter modules that still CONTAIN
//     write SQL against frozen legacy tables. Their store layers throw the
//     typed frozen errors (`pending_ask_frozen` / `pending_interaction`
//     freeze / `worker_run_frozen` — pinned by conformance), so the SQL is
//     reachable only by seeding archived fixtures at the adapter layer; no
//     OTHER module may carry write SQL for a frozen table.

import { Glob } from "bun";
import { join } from "node:path";

export interface LedgerStreamProducer {
  /** Stream class key — must match `LedgerAppend.StreamRegistry`. */
  readonly streamClass: "wait" | "work" | "route" | "command" | "effect";
  /** Repo-relative path of the ONE module that appends this class's facts. */
  readonly producer: string;
  /** Which ledger write APIs the producer uses. */
  readonly writes: "append" | "append+adoptStream";
}

export interface LedgerProducerManifest {
  readonly streams: readonly LedgerStreamProducer[];
  /** Modules allowed to write `ledger_event`/`ledger_head` rows directly, plus the sub-adapter binding. */
  readonly appendCore: readonly string[];
  /** Frozen legacy tables and the ONLY modules still containing write SQL for them. */
  readonly frozenTableWriters: readonly { table: string; adapter: string }[];
}

export const LEDGER_PRODUCER_MANIFEST: LedgerProducerManifest = {
  streams: [
    {
      streamClass: "wait",
      producer: "packages/session/src/wait/index.ts",
      writes: "append+adoptStream",
    },
    {
      streamClass: "work",
      producer: "packages/session/src/work-item/facts.ts",
      writes: "append+adoptStream",
    },
    {
      streamClass: "route",
      producer: "packages/openomni/src/ingress/routing-resolution.ts",
      writes: "append",
    },
    {
      streamClass: "command",
      producer: "packages/openomni/src/dispatch/runtime.ts",
      writes: "append",
    },
    {
      streamClass: "effect",
      producer: "packages/session/src/effect/index.ts",
      writes: "append",
    },
  ],
  appendCore: [
    // Raw prepared-statement writers of ledger_event/ledger_head:
    "packages/session/src/ledger-core/append.ts",
    "packages/session/src/ledger-core/adopt.ts",
    // The storage adapter binding that exposes them as `Storage.ledger`:
    "packages/session/src/storage/sqlite-storage.ts",
  ],
  frozenTableWriters: [
    { table: "pending_ask", adapter: "packages/session/src/storage/sqlite-pending-ask-adapter.ts" },
    {
      table: "pending_interaction",
      adapter: "packages/session/src/storage/sqlite-pending-interaction-adapter.ts",
    },
    {
      table: "worker_run_state",
      adapter: "packages/session/src/storage/sqlite-worker-run-state-adapter.ts",
    },
  ],
};

/** Production source files scanned by the gate: packages/apps src trees, tests excluded. */
const SOURCE_GLOB = new Glob("{packages,apps}/*/src/**/*.ts");

const LEDGER_WRITE_CALL = /\b[Ll]edger\s*\.\s*(?:append|adoptStream)\s*\(/;
const LEDGER_TABLE_WRITE_SQL = /(?:INSERT INTO|UPDATE|DELETE FROM)\s+ledger_(?:event|head)\b/;
const FROZEN_TABLE_WRITE_SQL =
  /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:pending_ask|pending_interaction|worker_run_state)\b/;

// Doc-comment lines (this codebase's comment style: a leading `*`, `//`, or
// `/*`) mention `Ledger.append` as vocabulary; only code lines count as a
// write site.
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

function fileMatches(content: string, pattern: RegExp): boolean {
  return content.split("\n").some((line) => !isCommentLine(line) && pattern.test(line));
}

export interface LedgerProducerScan {
  /** Files containing a `ledger.append(`/`ledger.adoptStream(` call site. */
  readonly appendCallSites: readonly string[];
  /** Files containing write SQL against ledger_event/ledger_head. */
  readonly ledgerTableWriters: readonly string[];
  /** Files containing write SQL against a frozen legacy table. */
  readonly frozenTableWriters: readonly string[];
}

/** Scans the production source tree for every ledger/frozen-table write surface. */
export async function scanLedgerProducers(rootDir: string): Promise<LedgerProducerScan> {
  const appendCallSites: string[] = [];
  const ledgerTableWriters: string[] = [];
  const frozenTableWriters: string[] = [];
  const files = [...SOURCE_GLOB.scanSync({ cwd: rootDir })].filter(
    (file) => !file.endsWith(".test.ts"),
  );
  files.sort();
  for (const file of files) {
    const content = await Bun.file(join(rootDir, file)).text();
    if (fileMatches(content, LEDGER_WRITE_CALL)) appendCallSites.push(file);
    if (fileMatches(content, LEDGER_TABLE_WRITE_SQL)) ledgerTableWriters.push(file);
    if (fileMatches(content, FROZEN_TABLE_WRITE_SQL)) frozenTableWriters.push(file);
  }
  return { appendCallSites, ledgerTableWriters, frozenTableWriters };
}
