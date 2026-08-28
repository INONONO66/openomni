/**
 * Per-package line-coverage ratchet.
 *
 * Each CI test step emits an lcov report (`bun test --coverage
 * --coverage-reporter=lcov --coverage-dir=coverage`). This script reads
 * `coverage/lcov.info` under every `packages/` and `apps/` workspace dir,
 * computes each package's line coverage over its OWN `src/` files, and
 * compares against the grandfathered baseline. Only `src/` records count:
 * bun's lcov also lists cross-package files loaded through workspace imports
 * (`../protocol/src/...` — ledger tests must not get credit for protocol
 * lines), compiled `dist/` duplicates (which would tie the number to build
 * staleness), and `test/` harness files.
 *
 * Failure modes:
 *   - a package's coverage fell more than TOLERANCE_PP below its baseline
 *     (small run-to-run variance from timing-dependent branches is expected;
 *     the tolerance absorbs it, a real regression does not hide in it)
 *   - a package emits coverage but has no baseline entry (growth is the
 *     Owner-sign-off diff — run --update)
 *   - a baselined package produced no report (a silently disabled gate is
 *     the worst regression — run the suite with coverage, or --update after
 *     an intentional removal)
 *
 * Modes:
 *   bun run script/check-coverage-ratchet.ts             check against baseline
 *   bun run script/check-coverage-ratchet.ts --update    rewrite baseline from
 *                                                        current reports (diff =
 *                                                        sign-off surface; shrink
 *                                                        is autonomous)
 *   bun run script/check-coverage-ratchet.ts --self-test discrimination bench on
 *                                                        synthetic fixtures only
 */

import { readFileSync, writeFileSync } from "node:fs";
import { assertTopologyComplete, coverageWorkspaces, TOPOLOGY } from "./topology";

const BASELINE_PATH = "script/conformance/coverage-baseline.json";
// 0.5pp absorbs the measured stable macOS<->ubuntu platform offset (coordinator
// showed 0.45pp on the first CI run) while still catching real regressions.
const TOLERANCE_PP = 0.5;

export interface PackageCoverage {
  readonly linesFound: number;
  readonly linesHit: number;
  readonly pct: number;
}

export type CoverageBaseline = Readonly<Record<string, PackageCoverage>>;

export interface CoverageComparison {
  readonly violations: readonly string[];
  readonly improvements: readonly string[];
}

export function coveragePct(linesFound: number, linesHit: number): number {
  if (linesFound === 0) {
    return 100;
  }
  return Math.round((10_000 * linesHit) / linesFound) / 100;
}

/**
 * Sums LF/LH over the package's own source records. `SF:` paths are relative
 * to the package dir the suite ran in; only `src/` records count (see header
 * for why `../`, `dist/`, and `test/` records are skipped).
 */
export function parseLcovSummary(lcovText: string): PackageCoverage {
  let linesFound = 0;
  let linesHit = 0;
  let currentFile = "";
  let fileFound = 0;
  let fileHit = 0;

  for (const rawLine of lcovText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3);
      fileFound = 0;
      fileHit = 0;
    } else if (line.startsWith("LF:")) {
      fileFound = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      fileHit = Number(line.slice(3));
    } else if (line === "end_of_record") {
      if (currentFile.startsWith("src/")) {
        linesFound += fileFound;
        linesHit += fileHit;
      }
      currentFile = "";
    }
  }

  return { linesFound, linesHit, pct: coveragePct(linesFound, linesHit) };
}

export function compareCoverage(
  baseline: CoverageBaseline,
  current: Readonly<Record<string, PackageCoverage>>,
  tolerancePp: number,
): CoverageComparison {
  const violations: string[] = [];
  const improvements: string[] = [];

  for (const [packageDir, coverage] of Object.entries(current)) {
    const base = baseline[packageDir];
    if (!base) {
      violations.push(
        `${packageDir}: covered package missing from coverage baseline (currently ${coverage.pct}%) — run --update (growing the baseline needs Owner sign-off in review)`,
      );
      continue;
    }
    // Fail closed when instrumentation collapses: an empty or mass-filtered
    // report scores 100% and would otherwise pass as an "improvement" with no
    // baseline diff (no sign-off surface). A silently disabled gate is the
    // worst regression this script exists to prevent.
    if (coverage.linesFound === 0 && base.linesFound > 0) {
      violations.push(
        `${packageDir}: coverage report contains zero src/ line records while the baseline has ${base.linesFound} — instrumentation was disabled or filtered away; the gate fails closed`,
      );
      continue;
    }
    if (coverage.linesFound < base.linesFound * 0.5) {
      violations.push(
        `${packageDir}: instrumented line count collapsed from ${base.linesFound} to ${coverage.linesFound} (more than half) — coverage filtering or package scope changed; re-baseline via --update (sign-off diff)`,
      );
      continue;
    }
    const deltaPp = coverage.pct - base.pct;
    if (deltaPp < -tolerancePp) {
      violations.push(
        `${packageDir}: line coverage fell ${(-deltaPp).toFixed(2)}pp below baseline (${base.pct}% → ${coverage.pct}%; tolerance ${tolerancePp}pp)`,
      );
    } else if (deltaPp > tolerancePp) {
      improvements.push(
        `${packageDir}: line coverage improved ${deltaPp.toFixed(2)}pp over baseline (${base.pct}% → ${coverage.pct}%) — shrink the baseline via --update`,
      );
    }
  }

  for (const packageDir of Object.keys(baseline)) {
    if (!(packageDir in current)) {
      violations.push(
        `${packageDir}: baselined package produced no coverage report — run its test suite with --coverage first (intentional removal goes through --update)`,
      );
    }
  }

  return { violations, improvements };
}

async function collectCurrentCoverage(): Promise<Record<string, PackageCoverage>> {
  const collected: Record<string, PackageCoverage> = {};
  for (const workspace of TOPOLOGY) {
    const reportPath = `${workspace.dir}/coverage/lcov.info`;
    const report = Bun.file(reportPath);
    if (!(await report.exists())) continue;
    if (!workspace.coverageLane) {
      throw new Error(
        `${workspace.dir}: coverage report exists but topology explicitly sets coverageLane: false`,
      );
    }
    collected[workspace.dir] = parseLcovSummary(await report.text());
  }
  return Object.fromEntries(Object.entries(collected).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline(): CoverageBaseline {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as CoverageBaseline;
  const expected = coverageWorkspaces().map((workspace) => workspace.dir).sort();
  const actual = Object.keys(baseline).sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      `coverage baseline topology drift: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    );
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// self-test — synthetic fixtures only; never reads real reports or baseline
// ---------------------------------------------------------------------------

function lcovFixture(records: ReadonlyArray<{ file: string; hits: readonly number[] }>): string {
  const chunks: string[] = ["TN:"];
  for (const record of records) {
    chunks.push(`SF:${record.file}`);
    record.hits.forEach((hit, index) => {
      chunks.push(`DA:${index + 1},${hit}`);
    });
    chunks.push(
      `LF:${record.hits.length}`,
      `LH:${record.hits.filter((hit) => hit > 0).length}`,
      "end_of_record",
    );
  }
  return `${chunks.join("\n")}\n`;
}

function selfTest(): void {
  const failures: string[] = [];

  const parsed = parseLcovSummary(
    lcovFixture([
      { file: "src/a.ts", hits: [1, 1, 0, 1] },
      { file: "../protocol/src/foreign.ts", hits: [0, 0, 0, 0] },
      { file: "dist/a.js", hits: [1, 1, 1, 1] },
      { file: "test/harness.ts", hits: [1, 1] },
    ]),
  );
  if (parsed.linesFound !== 4 || parsed.linesHit !== 3 || parsed.pct !== 75) {
    failures.push(
      `lcov parser wrong: expected 3/4 src/ lines (75%), got ${parsed.linesHit}/${parsed.linesFound} (${parsed.pct}%)`,
    );
  }

  const syntheticBaseline: CoverageBaseline = {
    "packages/fixture": { linesFound: 100, linesHit: 90, pct: 90 },
  };
  const worse = compareCoverage(
    syntheticBaseline,
    { "packages/fixture": { linesFound: 100, linesHit: 89, pct: 89 } },
    TOLERANCE_PP,
  );
  if (worse.violations.length !== 1) {
    failures.push("a 1.00pp regression below baseline was not flagged");
  }

  const equal = compareCoverage(
    syntheticBaseline,
    { "packages/fixture": { linesFound: 100, linesHit: 90, pct: 90 } },
    TOLERANCE_PP,
  );
  const better = compareCoverage(
    syntheticBaseline,
    { "packages/fixture": { linesFound: 100, linesHit: 95, pct: 95 } },
    TOLERANCE_PP,
  );
  if (equal.violations.length !== 0 || better.violations.length !== 0) {
    failures.push("equal-or-better coverage was flagged as a regression");
  }
  if (better.improvements.length !== 1) {
    failures.push("an improvement did not produce a shrink-the-baseline note");
  }

  const withinTolerance = compareCoverage(
    syntheticBaseline,
    { "packages/fixture": { linesFound: 1000, linesHit: 899, pct: 89.9 } },
    TOLERANCE_PP,
  );
  if (withinTolerance.violations.length !== 0) {
    failures.push("a 0.10pp dip inside the tolerance band was flagged");
  }

  const unbaselined = compareCoverage(
    syntheticBaseline,
    {
      "packages/fixture": { linesFound: 100, linesHit: 90, pct: 90 },
      "packages/new-pkg": { linesFound: 10, linesHit: 10, pct: 100 },
    },
    TOLERANCE_PP,
  );
  if (unbaselined.violations.length !== 1) {
    failures.push("a covered package missing from the baseline was not flagged");
  }

  const missingReport = compareCoverage(syntheticBaseline, {}, TOLERANCE_PP);
  if (missingReport.violations.length !== 1) {
    failures.push("a baselined package with no coverage report was not flagged");
  }

  const zeroRecords = compareCoverage(
    syntheticBaseline,
    { "packages/fixture": { linesFound: 0, linesHit: 0, pct: 100 } },
    TOLERANCE_PP,
  );
  if (zeroRecords.violations.length !== 1) {
    failures.push(
      "a zero-record report (disabled/filtered instrumentation scoring 100%) was not flagged",
    );
  }

  const collapsed = compareCoverage(
    syntheticBaseline,
    { "packages/fixture": { linesFound: 40, linesHit: 40, pct: 100 } },
    TOLERANCE_PP,
  );
  if (collapsed.violations.length !== 1) {
    failures.push("an instrumented-line collapse below half the baseline was not flagged");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`SELF-TEST FAIL: ${failure}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    "OK: coverage-ratchet self-test — regression/growth/missing-report/zero-record/line-collapse discriminate, equal-or-better passes\n",
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

  assertTopologyComplete();
  const current = await collectCurrentCoverage();
  const expectedCoverageDirs = coverageWorkspaces().map((workspace) => workspace.dir).sort();

  if (args.has("--update")) {
    const actualCoverageDirs = Object.keys(current).sort();
    if (actualCoverageDirs.join("\n") !== expectedCoverageDirs.join("\n")) {
      throw new Error(
        `coverage update requires every topology coverage lane: expected [${expectedCoverageDirs.join(", ")}], got [${actualCoverageDirs.join(", ")}]`,
      );
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(
      `OK: coverage baseline regenerated (${Object.keys(current).length} packages) — this diff is the sign-off surface\n`,
    );
    return;
  }

  const { violations, improvements } = compareCoverage(readBaseline(), current, TOLERANCE_PP);

  for (const improvement of improvements) {
    process.stdout.write(`IMPROVED: ${improvement}\n`);
  }

  if (violations.length === 0) {
    const summary = Object.entries(current)
      .map(([packageDir, coverage]) => `${packageDir} ${coverage.pct}%`)
      .join(", ");
    process.stdout.write(`OK: coverage ratchet (tolerance ${TOLERANCE_PP}pp) — ${summary}\n`);
    return;
  }

  for (const violation of violations) {
    process.stderr.write(`VIOLATION [coverage-ratchet] ${violation}\n`);
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
