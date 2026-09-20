/**
 * Patch coverage gate (#1116): every changed executable line must be covered.
 *
 * Inputs are one or more lcov files (glob) plus a base ref. Changed and added
 * lines in packages/-/src, apps/-/src and top-level script *.ts files
 * (non-test) come from `git diff --unified=0 <base>...HEAD`. A changed line is
 * uncovered when the lcov union knows it (`DA:` record) with zero hits; lines
 * absent from every lcov are not executable (types, comments) and never count.
 * A gated file with NO `SF:` record in any lcov was never loaded by any test:
 * it fails outright (`<path>: no coverage record`) unless transpilation proves
 * the file has zero executable lines (type-only modules; `.d.ts` is excluded
 * from gating). Each lcov's repo prefix is inferred from its path: the segment
 * starting at `packages/`, `apps/` or `script` before the `coverage/`
 * directory.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const GATED = /^(?:(?:packages|apps)\/[^/]+\/src\/.+|script\/[^/]+\.ts)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|\.d\.ts$/;

export function gatedPath(path: string): boolean {
  return GATED.test(path) && !TEST_FILE.test(path);
}

/** repo prefix of an lcov file: `.../<packages/x|apps/x|script>/coverage/...` */
export function lcovPrefix(lcovPath: string): string {
  const segments = dirname(resolve(lcovPath)).split(sep);
  const coverage = segments.lastIndexOf("coverage");
  const owner = coverage === -1 ? segments : segments.slice(0, coverage);
  for (let index = owner.length - 1; index >= 0; index -= 1) {
    if (owner[index] === "packages" || owner[index] === "apps") {
      return owner.slice(index, index + 2).join("/");
    }
  }
  return owner.at(-1) === "script" ? "script" : "";
}

function recordHit(rows: Map<number, number>, record: string): void {
  const [lineNumber, hits] = record.split(",").map(Number);
  if (lineNumber === undefined || hits === undefined || Number.isNaN(lineNumber)) return;
  rows.set(lineNumber, Math.max(rows.get(lineNumber) ?? 0, hits));
}

function mergeLcov(union: Map<string, Map<number, number>>, file: string, root: string): void {
  const prefix = lcovPrefix(file);
  if (prefix === "") throw new Error(`lcov without workspace ancestor (flattened artifact?): ${file}`);
  let source = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      const raw = line.slice(3).trim();
      source = isAbsolute(raw) ? relative(root, raw) : `${prefix}/${raw}`;
      continue;
    }
    if (!line.startsWith("DA:") || source === "") continue;
    const rows = union.get(source) ?? new Map<number, number>();
    union.set(source, rows);
    recordHit(rows, line.slice(3));
  }
}

/** Union of DA records across lcov files: repo path -> line -> max hits. */
export function lcovUnion(
  files: readonly string[],
  root: string,
): Map<string, Map<number, number>> {
  const union = new Map<string, Map<number, number>>();
  for (const file of files) mergeLcov(union, file, root);
  return union;
}

/** Changed/added line numbers per gated repo path from a unified-0 diff. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let path = "";
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line);
    if (file?.[1] !== undefined) {
      path = gatedPath(file[1]) ? file[1] : "";
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk?.[1] === undefined || path === "") continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const rows = changed.get(path) ?? new Set<number>();
    changed.set(path, rows);
    for (let row = start; row < start + count; row += 1) rows.add(row);
  }
  return changed;
}

/** True when the type-stripped emit of a module still contains code. */
export function hasExecutableCode(source: string, path: string): boolean {
  const transpiled = new Bun.Transpiler({
    loader: path.endsWith(".tsx") ? "tsx" : "ts",
  }).transformSync(source);
  return transpiled.split("\n").some((line) => line.trim() !== "");
}

export function uncoveredRows(
  changed: Map<string, Set<number>>,
  union: Map<string, Map<number, number>>,
  isExecutable: (path: string) => boolean,
): string[] {
  const rows: string[] = [];
  for (const [path, lines] of [...changed.entries()].sort()) {
    const coverage = union.get(path);
    if (coverage === undefined) {
      // No lane ever loaded this file. Type-only modules emit nothing and are
      // exempt; anything else is untested by construction and fails closed.
      if (isExecutable(path)) rows.push(`${path}: no coverage record`);
      continue;
    }
    for (const line of [...lines].sort((a, b) => a - b)) {
      if (coverage.get(line) === 0) rows.push(`${path}:${line}`);
    }
  }
  return rows;
}

export function checkPatchCoverage(base: string, globs: readonly string[], root: string): string[] {
  const diff = Bun.spawnSync(
    ["git", "diff", "--no-ext-diff", "--no-renames", "--unified=0", `${base}...HEAD`, "--"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (diff.exitCode !== 0) throw new Error(`git diff failed: ${diff.stderr.toString()}`);
  const files = globs.flatMap((glob) => [
    ...new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: true }),
  ]);
  const union = lcovUnion(
    files.map((file) => resolve(root, file)),
    root,
  );
  // Every path with added lines in a base...HEAD diff exists at HEAD, so the
  // read is trusted; an unexpected failure crashes the gate, which fails closed.
  const isExecutable = (path: string): boolean =>
    hasExecutableCode(readFileSync(resolve(root, path), "utf8"), path);
  return uncoveredRows(changedLines(diff.stdout.toString()), union, isExecutable);
}

export function main(
  argv: readonly string[] = Bun.argv.slice(2),
  root: string = process.cwd(),
): number {
  const { values } = parseArgs({
    args: [...argv],
    options: { base: { type: "string" }, glob: { type: "string", multiple: true } },
    strict: true,
  });
  if (values.base === undefined || values.glob === undefined || values.glob.length === 0) {
    throw new Error("usage: check-patch-coverage.ts --base <ref> --glob <lcov-glob> [--glob ...]");
  }
  const rows = checkPatchCoverage(values.base, values.glob, root);
  for (const row of rows) console.error(`uncovered: ${row}`);
  if (rows.length > 0) {
    console.error(`patch coverage: ${rows.length} changed executable line(s) uncovered`);
    return 1;
  }
  console.log("patch coverage: all changed executable lines are covered");
  return 0;
}

if (import.meta.main) process.exitCode = main();
