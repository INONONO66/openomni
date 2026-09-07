#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import { replaceFileAtomically } from "../packages/ledger/src/index";
import {
  initializeSqliteDatabase,
  preflightSqliteDatabase,
} from "../packages/ledger/src/storage/sqlite-schema-lifecycle";
import {
  DispositionCandidates,
  inspect967Projections,
} from "../packages/ledger/src/storage/u967-projection";
import { sqliteSchema, U967Error } from "../packages/ledger/src/storage/u967-preflight";
import { canonicalDigest } from "../packages/protocol/src/index";
import {
  archiveTableEntries,
  assertArchiveEquality,
  fileSha256,
  withRestoredArchive,
} from "./ledger-archive-snapshot";

/** One existing archive owner; the native SQLite image is the lossless artifact. */
export function buildLedgerArchiveManifest(db: Database, generatedAt = Date.now()) {
  const migrations = db
    .query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY rowid")
    .all();
  const sourceSchemaVersion = migrations.at(-1)?.name;
  if (sourceSchemaVersion === undefined) throw new U967Error("unsupported_upgrade");
  const tables = archiveTableEntries(db, sourceSchemaVersion);
  const projection = tables.some((table) => table.table === "wait")
    ? inspect967Projections(db, generatedAt)
    : { candidates: [], blocked: ["unsupported_upgrade"] };
  return {
    manifestVersion: 2 as const,
    generatedAt,
    migrations,
    schemaHash: canonicalDigest(sqliteSchema(db)),
    tables,
    ...projection,
  };
}
export type LedgerArchiveManifest = ReturnType<typeof buildLedgerArchiveManifest>;

type ReplaceFile = (temporaryPath: string, finalPath: string) => void;
export async function writeArchiveManifestAtomically(
  outPath: string,
  contents: string,
  replace?: ReplaceFile,
): Promise<void> {
  replaceFileAtomically(outPath, contents, {
    durable: true,
    mode: 0o600,
    ...(replace === undefined ? {} : { replace }),
  });
}

const Receipt = z.strictObject({
  manifestVersion: z.literal(2),
  generatedAt: z.number().finite(),
  schemaHash: z.string(),
  migrations: z.array(z.strictObject({ name: z.string() })),
  candidates: DispositionCandidates,
  blocked: z.array(z.string()),
  tables: z.array(
    z.strictObject({
      table: z.string(),
      sourceSchemaVersion: z.string(),
      columns: z.array(z.string()),
      keys: z.array(z.string()),
      rowCount: z.number().int().nonnegative(),
      idRange: z
        .strictObject({ first: z.string().nullable(), last: z.string().nullable() })
        .nullable(),
      integrityHash: z.string(),
    }),
  ),
  source: z.strictObject({
    path: z.string(),
    device: z.string(),
    inode: z.string(),
    head: z.string(),
    tree: z.string(),
    bun: z.string(),
    sqlite: z.string(),
  }),
  backup: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
  }),
});

function safePath(path: string, existing: boolean): void {
  if (path !== resolve(path) || realpathSync(dirname(path)) !== dirname(path))
    throw new U967Error("unsafe_path");
  if (!existsSync(path)) {
    if (existing) throw new U967Error("archive_missing");
    return;
  }
  const stat = lstatSync(path);
  if (!existing || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new U967Error("unsafe_path");
}

function sourceIdentity(path: string) {
  const stat = statSync(path, { bigint: true });
  return { path, device: String(stat.dev), inode: String(stat.ino) };
}

function revision(ref: string): string {
  const command = Bun.spawnSync(["git", "rev-parse", ref], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (command.exitCode !== 0) throw new U967Error("source_revision_unavailable");
  return command.stdout.toString().trim();
}

function parseCommand(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      db: { type: "string" },
      out: { type: "string" },
      backup: { type: "string" },
      json: { type: "boolean" },
      verify: { type: "boolean" },
      "dispose-967": { type: "boolean" },
      "approve-manifest-sha256": { type: "string" },
    },
  });
  if (!values.db || !values.out || !values.backup) throw new U967Error("explicit_paths_required");
  if (values.verify && values["dispose-967"]) throw new U967Error("invalid_command");
  if (values["dispose-967"] && !values["approve-manifest-sha256"])
    throw new U967Error("approval_required");
  if (values["approve-manifest-sha256"] && !values["dispose-967"])
    throw new U967Error("invalid_command");
  const paths = [values.db, values.out, values.backup];
  if (
    new Set(paths).size !== 3 ||
    paths.some((path) =>
      paths.some((other) =>
        ["-wal", "-shm", "-journal"].some((suffix) => path === `${other}${suffix}`),
      ),
    )
  )
    throw new U967Error("unsafe_path");
  safePath(values.db, true);
  safePath(values.out, Boolean(values.verify || values["dispose-967"]));
  safePath(values.backup, Boolean(values.verify || values["dispose-967"]));
  return {
    db: values.db,
    out: values.out,
    backup: values.backup,
    verify: values.verify,
    dispose: values["dispose-967"],
    approval: values["approve-manifest-sha256"],
  };
}

type Command = ReturnType<typeof parseCommand>;
function readReceipt(command: Command) {
  for (const path of [command.db, command.out, command.backup]) safePath(path, true);
  const bytes = readFileSync(command.out);
  if (command.dispose && createHash("sha256").update(bytes).digest("hex") !== command.approval)
    throw new U967Error("digest_mismatch");
  const manifest = Receipt.parse(JSON.parse(bytes.toString("utf8")));
  const { path, device, inode } = manifest.source;
  if (
    !isDeepStrictEqual(sourceIdentity(command.db), { path, device, inode }) ||
    manifest.backup.path !== command.backup
  )
    throw new U967Error("unsafe_path");
  if (statSync(command.backup).size !== manifest.backup.bytes)
    throw new U967Error("digest_mismatch");
  return manifest;
}

function verifyReceipt(db: Database, command: Command) {
  const manifest = readReceipt(command);
  const sourceState = preflightSqliteDatabase(db);
  withRestoredArchive(command.backup, manifest.backup.sha256, (restored) => {
    const archiveState = preflightSqliteDatabase(restored);
    const { source: _source, backup: _backup, ...expected } = manifest;
    if (!isDeepStrictEqual(buildLedgerArchiveManifest(restored, manifest.generatedAt), expected))
      throw new U967Error("digest_mismatch");
    assertArchiveEquality(db, restored, sourceState === "applied" && archiveState === "pending");
  });
  return { manifest, applied: sourceState === "applied" };
}

function verifyDisposition(db: Database, command: Command) {
  const { manifest, applied } = verifyReceipt(db, command);
  const projection = inspect967Projections(db, Date.now());
  if (manifest.blocked.length > 0 || projection.blocked.length > 0)
    throw new U967Error("protected_rows");
  if (!isDeepStrictEqual(projection.candidates, applied ? [] : manifest.candidates))
    throw new U967Error("stale_archive");
  return { manifest, projection, applied };
}

async function archive(db: Database, command: Command): Promise<void> {
  db.run("BEGIN");
  try {
    const manifest = buildLedgerArchiveManifest(db);
    const image = db.serialize();
    // link is an exclusive publication: even a race cannot overwrite an
    // operator artifact. The existing durable helper owns temporary cleanup.
    replaceFileAtomically(command.backup, image, { durable: true, mode: 0o600, replace: linkSync });
    const hash = fileSha256(command.backup);
    withRestoredArchive(command.backup, hash, (restored) => assertArchiveEquality(db, restored));
    const receipt = {
      ...manifest,
      source: {
        ...sourceIdentity(command.db),
        head: revision("HEAD"),
        tree: revision("HEAD^{tree}"),
        bun: Bun.version,
        sqlite:
          db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version ??
          "",
      },
      backup: { path: command.backup, sha256: hash, bytes: image.length },
    };
    await writeArchiveManifestAtomically(
      command.out,
      `${JSON.stringify(receipt, null, 2)}\n`,
      linkSync,
    );
  } finally {
    db.run("ROLLBACK");
  }
}

function dispose(db: Database, command: Command): string {
  // One read snapshot validates confirmation, artifacts and eligibility before
  // initialization can change journal mode or run predecessor transactions.
  db.run("BEGIN");
  let applied: boolean;
  try {
    applied = verifyDisposition(db, command).applied;
  } finally {
    db.run("ROLLBACK");
  }
  if (applied) {
    initializeSqliteDatabase(db);
    return "already_applied";
  }
  initializeSqliteDatabase(db, (locked) => {
    // The exact same validation and DELETE share the runner's BEGIN IMMEDIATE.
    const { manifest, projection } = verifyDisposition(locked, command);
    for (const candidate of projection.candidates) {
      const removed = locked
        .query("DELETE FROM wait WHERE id = ? AND revision = ? AND owner_kind = 'workItem'")
        .run(candidate.id, candidate.revision);
      if (removed.changes !== 1) throw new U967Error("stale_archive");
    }
    const bus = manifest.tables.find((table) => table.table === "bus_event");
    if (bus === undefined || locked.query("DELETE FROM bus_event").run().changes !== bus.rowCount)
      throw new U967Error("stale_archive");
  });
  return "disposed";
}

async function runArchiveCommand(argv: readonly string[]): Promise<string> {
  const command = parseCommand(argv);
  const db = new Database(command.db, {
    readonly: !command.dispose,
    readwrite: Boolean(command.dispose),
    safeIntegers: true,
  });
  try {
    if (command.dispose) return dispose(db, command);
    if (command.verify) {
      db.run("BEGIN");
      try {
        verifyReceipt(db, command);
        return "verified";
      } finally {
        db.run("ROLLBACK");
      }
    }
    await archive(db, command);
    return "archived";
  } finally {
    db.close(true);
  }
}

if (import.meta.main) {
  process.on("uncaughtExceptionMonitor", (error) => {
    if (error instanceof SuppressedError) {
      const failures = z
        .object({ error: z.instanceof(Error), suppressed: z.instanceof(Error) })
        .parse(error);
      console.error(
        JSON.stringify({
          ok: false,
          resultCode: "indeterminate_transaction",
          error: failures.error.message,
          suppressed: failures.suppressed.message,
        }),
      );
    } else {
      console.error(
        JSON.stringify({
          ok: false,
          resultCode: error instanceof U967Error ? error.code : "io_error",
          error: error.message,
        }),
      );
    }
  });
  const resultCode = await runArchiveCommand(process.argv.slice(2));
  console.log(JSON.stringify({ ok: true, resultCode }));
}
