/**
 * Source-metrics artifact — no gate.
 *
 * Counts tracked `*.ts` files and their physical LOC per workspace unit
 * (`packages/*`, `apps/*`), using `git ls-files` as the file source so
 * untracked scratch never skews the numbers. Excludes `dist/`,
 * `node_modules/`, and generated snapshots (`/generated/` dirs and
 * `*.generated.ts`). Writes the result to `source-metrics.json`; CI uploads
 * it as the `source-metrics` artifact so growth is observable over time.
 */

import { writeFileSync } from "node:fs";

const OUTPUT_PATH = "source-metrics.json";
const UNIT_ROOTS = new Set(["packages", "apps"]);
const EXCLUDED_PATH_PARTS = ["/dist/", "/node_modules/", "/generated/"];
const EXCLUDED_SUFFIXES = [".generated.ts"];

export interface UnitMetrics {
  readonly files: number;
  readonly loc: number;
}

export interface SourceMetrics {
  readonly commit: string;
  readonly units: Readonly<Record<string, UnitMetrics>>;
  readonly total: UnitMetrics;
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

export function unitOf(filePath: string): string | undefined {
  const [root, dir] = filePath.split("/");
  if (!(root && dir) || !UNIT_ROOTS.has(root)) {
    return undefined;
  }
  return `${root}/${dir}`;
}

export function isCountedSourceFile(filePath: string): boolean {
  if (!filePath.endsWith(".ts")) {
    return false;
  }
  if (EXCLUDED_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) {
    return false;
  }
  return !EXCLUDED_PATH_PARTS.some((part) => `/${filePath}`.includes(part));
}

async function runGit(args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited with code ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

async function main(): Promise<void> {
  const trackedFiles = (await runGit(["ls-files"])).split("\n").filter(Boolean);
  const commit = (await runGit(["rev-parse", "HEAD"])).trim();

  const units: Record<string, { files: number; loc: number }> = {};
  let totalFiles = 0;
  let totalLoc = 0;

  for (const filePath of trackedFiles) {
    const unit = unitOf(filePath);
    if (!unit || !isCountedSourceFile(filePath)) {
      continue;
    }
    const loc = countLines(await Bun.file(filePath).text());
    const entry = units[unit] ?? { files: 0, loc: 0 };
    units[unit] = entry;
    entry.files += 1;
    entry.loc += loc;
    totalFiles += 1;
    totalLoc += loc;
  }

  const metrics: SourceMetrics = {
    commit,
    units: Object.fromEntries(Object.entries(units).sort(([a], [b]) => a.localeCompare(b))),
    total: { files: totalFiles, loc: totalLoc },
  };

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(metrics, null, 2)}\n`);
  process.stdout.write(
    `OK: source metrics written to ${OUTPUT_PATH} (${Object.keys(units).length} units, ${totalFiles} files, ${totalLoc} LOC)\n`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  });
}
