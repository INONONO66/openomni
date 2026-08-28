#!/usr/bin/env bun
// #510 D2a — archive manifest for frozen legacy tables.
//
// The migration/archive boundary (issue #510) requires every frozen legacy
// writer's historical rows to be enumerated and archived with source schema
// version, range identity, and an integrity hash BEFORE the writer/table can
// ever be deleted. This script produces that durable artifact as JSON:
//
//   - one entry per frozen table (worker_run_state since #510 D2b; the
//     pending_ask/pending_interaction entries retired with migration 0025,
//     which refuses to drop non-empty tables — archive at a pre-0025
//     revision first);
//   - sourceSchemaVersion: the last applied migration name from `_migrations`
//     at generation time — the schema the frozen rows were persisted under;
//   - rowCount + idRange (first/last id in id order): range identity;
//   - integrityHash: sha256 over the canonical JSON of ALL rows in id order
//     (protocol `WorkItem.canonicalDigest` — the one exported digest owner).
//     This is a table-level range hash, NOT the bus/ledger event chain.
//
// Artifact path convention: `ledger-archive-manifest.json` NEXT TO the
// database file (production default `~/.openomni/ledger-archive-manifest.json`
// beside `storage.db`). Verification is the conformance case in
// script/generate-ledger-archive-manifest.test.ts: regenerating over the same
// rows reproduces the hash byte-for-byte; a tampered row mismatches.
//
// Usage:
//   bun run script/generate-ledger-archive-manifest.ts [--db <path>] [--out <path>]

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { WorkItem } from "../packages/protocol/src/index";

/** Frozen legacy tables enumerated by the manifest (grows as writers freeze). */
const FROZEN_TABLES: readonly { table: string; idColumn: string }[] = [
  { table: "worker_run_state", idColumn: "run_id" },
];

interface LedgerArchiveTableEntry {
  readonly table: string;
  readonly sourceSchemaVersion: string;
  readonly rowCount: number;
  readonly idRange: { readonly first: string; readonly last: string } | null;
  readonly integrityHash: string;
}

export interface LedgerArchiveManifest {
  readonly manifestVersion: 1;
  readonly generatedAt: number;
  readonly tables: readonly LedgerArchiveTableEntry[];
}

function lastAppliedMigration(db: Database): string {
  const row = db.query("SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1").get() as {
    name: string;
  } | null;
  if (!row) {
    throw new Error("no applied migrations found — not an initialized openomni database");
  }
  return row.name;
}

function buildTableEntry(
  db: Database,
  spec: { table: string; idColumn: string },
  sourceSchemaVersion: string,
): LedgerArchiveTableEntry {
  // Table and column names come from the FROZEN_TABLES constant only.
  const rows = db.query(`SELECT * FROM ${spec.table} ORDER BY ${spec.idColumn}`).all() as Record<
    string,
    unknown
  >[];
  const first = rows.at(0);
  const last = rows.at(-1);
  return {
    table: spec.table,
    sourceSchemaVersion,
    rowCount: rows.length,
    idRange:
      first && last
        ? { first: String(first[spec.idColumn]), last: String(last[spec.idColumn]) }
        : null,
    integrityHash: WorkItem.canonicalDigest(rows),
  };
}

/**
 * Builds the archive manifest over an open connection. Deterministic for a
 * fixed row set (except `generatedAt`): the same rows always reproduce the
 * same per-table `integrityHash`.
 */
export function buildLedgerArchiveManifest(db: Database): LedgerArchiveManifest {
  const sourceSchemaVersion = lastAppliedMigration(db);
  return {
    manifestVersion: 1,
    generatedAt: Date.now(),
    tables: FROZEN_TABLES.map((spec) => buildTableEntry(db, spec, sourceSchemaVersion)),
  };
}

type ReplaceFile = (temporaryPath: string, finalPath: string) => Promise<void>;

/** Replaces a durable manifest without exposing a partial final file. */
export async function writeArchiveManifestAtomically(
  outPath: string,
  contents: string,
  replaceFile: ReplaceFile = rename,
): Promise<void> {
  const directory = dirname(outPath);
  const temporaryPath = join(
    directory,
    `.${basename(outPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;

  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      await temporary.writeFile(contents, "utf8");
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    await replaceFile(temporaryPath, outPath);
    temporaryExists = false;

    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function parseArgs(argv: readonly string[]): { dbPath: string; outPath: string } {
  let dbPath = join(homedir(), ".openomni", "storage.db");
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--db" || flag === "--out") {
      if (value === undefined) {
        throw new Error(`missing value for ${flag} (usage: [--db <path>] [--out <path>])`);
      }
      if (flag === "--db") dbPath = value;
      else outPath = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag} (usage: [--db <path>] [--out <path>])`);
    }
  }
  return { dbPath, outPath: outPath ?? join(dirname(dbPath), "ledger-archive-manifest.json") };
}

if (import.meta.main) {
  const { dbPath, outPath } = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath, { readonly: true });
  try {
    const manifest = buildLedgerArchiveManifest(db);
    await writeArchiveManifestAtomically(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const entry of manifest.tables) {
      console.log(
        `[ledger-archive-manifest] ${entry.table}: ${entry.rowCount} row(s), schema ${entry.sourceSchemaVersion}, ${entry.integrityHash}`,
      );
    }
    console.log(`[ledger-archive-manifest] wrote ${outPath}`);
  } finally {
    db.close();
  }
}
