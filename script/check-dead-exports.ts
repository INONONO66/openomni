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

/** Flattens a knip JSON report into sorted, stable issue keys. */
export function normalizeKnipIssues(report: KnipReport): string[] {
  const keys = new Set<string>();

  for (const record of report.issues) {
    for (const [issueType, value] of Object.entries(record)) {
      if (issueType === "file" || value === null || value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          collectEntry(keys, issueType, record.file, entry, undefined);
        }
      } else if (typeof value === "object") {
        // enumMembers / namespaceMembers: { ParentName: [entry, ...] }
        for (const [parent, entries] of Object.entries(value)) {
          if (!Array.isArray(entries)) {
            continue;
          }
          for (const entry of entries) {
            collectEntry(keys, issueType, record.file, entry, parent);
          }
        }
      }
    }
  }

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

async function runKnip(): Promise<KnipReport> {
  const proc = Bun.spawn({ cmd: KNIP_CMD, stdout: "pipe", stderr: "pipe" });
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

function readBaseline(): DeadExportBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as DeadExportBaseline;
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

  const currentKeys = normalizeKnipIssues(await runKnip());

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
      `OK: dead-export ratchet — ${currentKeys.length} known issues, none new${shrinkNote}\n`,
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
