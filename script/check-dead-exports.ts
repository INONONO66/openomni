/**
 * Dead-export ratchet over knip.
 *
 * Runs `bunx knip --reporter json` (config: knip.json), normalizes every
 * reported issue to a stable key — issue type + file + identifier, no
 * line/column so unrelated edits don't shift keys — and compares against the
 * grandfathered baseline:
 *
 *   - a key NOT in the baseline fails the check (new dead export/type/file)
 *   - baseline keys no longer reported pass at check time; the shrink happens
 *     via --update (autonomous and encouraged — growing the baseline needs
 *     Owner sign-off in review)
 *
 * Modes:
 *   bun run script/check-dead-exports.ts             check against baseline
 *   bun run script/check-dead-exports.ts --update    rewrite baseline from the
 *                                                    current knip report (diff =
 *                                                    sign-off surface)
 *   bun run script/check-dead-exports.ts --self-test discrimination bench on
 *                                                    synthetic reports only
 */

import { readFileSync, writeFileSync } from "node:fs";
import { knipWorkspaces } from "./topology";

const BASELINE_PATH = "script/conformance/knip-baseline.json";
const KNIP_CMD = ["bunx", "knip", "--reporter", "json", "--no-exit-code"];

export interface KnipFileRecord {
  readonly file: string;
  readonly [issueType: string]: unknown;
}

export interface KnipReport {
  readonly issues: readonly KnipFileRecord[];
}

interface DeadExportBaseline {
  readonly grandfathered: readonly string[];
}

export interface DeadExportComparison {
  readonly newIssues: readonly string[];
  readonly resolved: readonly string[];
}

function entryName(entry: unknown): string {
  if (typeof entry === "object" && entry !== null && "name" in entry) {
    return String((entry as { name: unknown }).name);
  }
  return String(entry);
}

function collectEntry(
  keys: Set<string>,
  issueType: string,
  file: string,
  entry: unknown,
  parent: string | undefined,
): void {
  if (Array.isArray(entry)) {
    // duplicates are reported as groups (arrays of entries)
    for (const inner of entry) {
      collectEntry(keys, issueType, file, inner, parent);
    }
    return;
  }
  if (issueType === "files") {
    keys.add(`files ${file}`);
    return;
  }
  const name = entryName(entry);
  keys.add(`${issueType} ${file} ${parent ? `${parent}.${name}` : name}`);
}

function collectMemberEntries(
  keys: Set<string>,
  issueType: string,
  file: string,
  members: object,
): void {
  // enumMembers / namespaceMembers: { ParentName: [entry, ...] }
  for (const [parent, entries] of Object.entries(members)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      collectEntry(keys, issueType, file, entry, parent);
    }
  }
}

function collectIssueValue(
  keys: Set<string>,
  issueType: string,
  file: string,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectEntry(keys, issueType, file, entry, undefined);
    }
  } else if (typeof value === "object" && value !== null) {
    collectMemberEntries(keys, issueType, file, value);
  }
}

function collectRecordIssues(keys: Set<string>, record: KnipFileRecord): void {
  for (const [issueType, value] of Object.entries(record)) {
    if (issueType === "file" || value === null || value === undefined) continue;
    collectIssueValue(keys, issueType, record.file, value);
  }
}

/** Flattens a knip JSON report into sorted, stable issue keys. */
export function normalizeKnipIssues(report: KnipReport): string[] {
  const keys = new Set<string>();
  for (const record of report.issues) collectRecordIssues(keys, record);
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

export function compareDeadExports(
  baselineKeys: readonly string[],
  currentKeys: readonly string[],
): DeadExportComparison {
  const baseline = new Set(baselineKeys);
  const current = new Set(currentKeys);
  return {
    newIssues: currentKeys.filter((key) => !baseline.has(key)),
    resolved: baselineKeys.filter((key) => !current.has(key)),
  };
}

function verifyKnipWorkspaceInventory(): void {
  const config = JSON.parse(readFileSync("knip.json", "utf8")) as {
    workspaces?: Record<string, unknown>;
  };
  const actual = Object.keys(config.workspaces ?? {}).sort();
  const expected = [".", ...knipWorkspaces().map((workspace) => workspace.dir)].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      `knip workspace topology drift: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    );
  }
}

export async function runKnip(
  cwd = ".",
  verifyInventory = true,
  includeEntryExports = false,
): Promise<KnipReport> {
  if (verifyInventory) verifyKnipWorkspaceInventory();
  const cmd = includeEntryExports ? [...KNIP_CMD, "--include-entry-exports"] : KNIP_CMD;
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // --no-exit-code makes issue-bearing runs exit 0; nonzero means knip itself
  // broke (config error, crash) and must not be read as "no issues".
  if (exitCode !== 0) {
    throw new Error(`knip exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  try {
    return JSON.parse(stdout) as KnipReport;
  } catch {
    throw new Error(`knip did not emit parseable JSON: ${stdout.slice(0, 200)}`);
  }
}

/** Strict census transport. Knip remains the export owner; no baseline is read. */
export function runProductionKnip(options: {
  readonly root: string;
  readonly executable: string;
  readonly config: string;
}): { ok: true; stdout: string } | { ok: false; code: string; message: string } {
  const version = Bun.spawnSync([process.execPath, options.executable, "--version"], {
    cwd: options.root, timeout: 30_000,
  });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== "6.31.0")
    return { ok: false, code: "tool_version", message: "census requires knip 6.31.0" };
  const result = Bun.spawnSync([
    process.execPath, options.executable, "--config", options.config,
    "--reporter", "json", "--no-exit-code", "--include-entry-exports",
    "--include", "files,exports,nsExports,types,nsTypes,enumMembers,namespaceMembers,unresolved",
    "--no-progress",
  ], { cwd: options.root, timeout: 120_000 });
  if (result.exitCode !== 0)
    return { ok: false, code: "knip_failure", message: result.stderr.toString().slice(0, 2000) };
  return { ok: true, stdout: result.stdout.toString() };
}

/** Join Knip's public surface with the shared invocation graph. Knip's lexical
 * use is not production consumption (registration/internal use may keep an
 * export in its graph). This owner emits the missing-consumer policy finding;
 * unresolved graph edges remain separate analyzer errors in the caller. */
export function productionConsumerFindings(rows: readonly {
  readonly definition: { readonly path: string; readonly line: number; readonly symbol: string };
  readonly consumers: readonly object[];
}[]): { path: string; line: number; symbol: string; class: "export" }[] {
  return rows.filter((row) => row.consumers.length === 0)
    .map((row) => ({ ...row.definition, class: "export" }));
}

function readBaseline(): DeadExportBaseline {
  // Tolerate a missing key: `--update` always writes the `grandfathered`
  // array (empty or not), but a hand-minimized `{}` baseline is still valid.
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Partial<DeadExportBaseline>;
  return { grandfathered: parsed.grandfathered ?? [] };
}

// ---------------------------------------------------------------------------
// self-test — synthetic reports only; never invokes knip or reads the baseline
// ---------------------------------------------------------------------------

function selfTest(): void {
  const failures: string[] = [];

  const fixtureReport: KnipReport = {
    issues: [
      {
        file: "packages/fixture/src/index.ts",
        exports: [{ name: "unusedFn", line: 3, col: 14 }],
        types: [{ name: "UnusedType", line: 9, col: 13 }],
        enumMembers: { Mode: [{ name: "LEGACY", line: 12, col: 3 }] },
      },
      {
        file: "packages/fixture/src/orphan.ts",
        files: [{ name: "packages/fixture/src/orphan.ts" }],
      },
    ],
  };
  const fixtureKeys = normalizeKnipIssues(fixtureReport);
  const expectedKeys = [
    "enumMembers packages/fixture/src/index.ts Mode.LEGACY",
    "exports packages/fixture/src/index.ts unusedFn",
    "files packages/fixture/src/orphan.ts",
    "types packages/fixture/src/index.ts UnusedType",
  ];
  if (fixtureKeys.join("\n") !== expectedKeys.join("\n")) {
    failures.push(`normalizer produced unexpected keys: ${fixtureKeys.join(" | ")}`);
  }

  const withNewIssue = normalizeKnipIssues({
    issues: [
      ...fixtureReport.issues,
      {
        file: "packages/fixture/src/extra.ts",
        exports: [{ name: "newDeadExport", line: 1, col: 14 }],
      },
    ],
  });
  const regression = compareDeadExports(fixtureKeys, withNewIssue);
  if (regression.newIssues.length !== 1 || !regression.newIssues[0]?.includes("newDeadExport")) {
    failures.push("a new dead export beyond the baseline was not flagged");
  }

  const identical = compareDeadExports(fixtureKeys, fixtureKeys);
  if (identical.newIssues.length !== 0) {
    failures.push("an unchanged report was flagged");
  }

  const improved = compareDeadExports(fixtureKeys, fixtureKeys.slice(1));
  if (improved.newIssues.length !== 0 || improved.resolved.length !== 1) {
    failures.push("a resolved baseline entry failed the check (shrink must be --update-only)");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`SELF-TEST FAIL: ${failure}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    "OK: dead-exports self-test — new issues discriminate, stale baseline entries pass at check time\n",
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--self-test")) {
    selfTest();
    return;
  }

  const [standardReport, entryExportReport] = await Promise.all([runKnip(), runKnip(".", true, true)]);
  const packageEntries = new Set(
    knipWorkspaces().map((workspace) => `${workspace.dir}/src/index.ts`),
  );
  const currentKeys = normalizeKnipIssues({
    issues: [
      ...standardReport.issues,
      ...entryExportReport.issues.filter((record) => packageEntries.has(record.file)),
    ],
  });

  if (args.has("--update")) {
    const baseline: DeadExportBaseline = { grandfathered: currentKeys };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `OK: dead-exports baseline regenerated (${currentKeys.length} issues) — this diff is the sign-off surface\n`,
    );
    return;
  }

  const { newIssues, resolved } = compareDeadExports(readBaseline().grandfathered, currentKeys);

  if (newIssues.length === 0) {
    const shrinkNote =
      resolved.length > 0
        ? `; ${resolved.length} baseline entr${resolved.length === 1 ? "y is" : "ies are"} no longer reported — shrink via --update`
        : "";
    process.stdout.write(
      `OK: dead-export ratchet — ${knipWorkspaces().length} topology workspaces scanned, ${currentKeys.length} known issues, none new${shrinkNote}\n`,
    );
    return;
  }

  for (const key of newIssues) {
    process.stderr.write(
      `VIOLATION [dead-exports] ${key} — new unused export/type/file beyond the baseline; delete it or get Owner sign-off to baseline it via --update\n`,
    );
  }
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  });
}
