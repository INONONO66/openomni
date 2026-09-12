import { afterAll, afterEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode, execute, sha256 } from "./run-quality-mutations";

type Json = ReturnType<typeof decode>;
type RecordValue = { [key: string]: Json };
type Fixture = { root: string; inventory: string; files: Record<string, string> };
class FixtureError {
  constructor(readonly message: string) {}
}
export function record(value: Json | undefined): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FixtureError("Expected report object");
  return value;
}
export function rows(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new FixtureError("Expected report array");
  return value;
}

function mutationDependencies(): string {
  const root = mkdtempSync(join(tmpdir(), "omo-mutation-dependencies-"));
  const locations = new Map<string, string>();
  // Preserve the compiler's real declaration dependencies, not the product tree.
  for (const [name, parent] of [["typescript", ""], ["@types/bun", ""], ["bun-types", "@types/bun"], ["@types/node", "bun-types"], ["undici-types", "@types/node"], ["zod", ""]] as const) {
    const location = dirname(Bun.resolveSync(`${name}/package.json`, locations.get(parent) ?? import.meta.dir));
    locations.set(name, location);
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(location, path);
  }
  return root;
}

async function createFixture(tool: string, roots: string[], source: string, assertion: string, additions: Record<string, string>): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "omo-mutation-test-"));
  roots.push(root);
  const files = {
    "src/a.ts": source,
    "src/a.test.ts": `import {test,expect} from "bun:test"; import {run} from "./a"; test("behavior", async()=>{${assertion}});`,
    ...additions,
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  writeFileSync(join(root, "src/tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: ["bun"], skipLibCheck: true },
    include: ["."],
  }));
  writeFileSync(join(root, "contract.json"), JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["src"], projects: ["src/tsconfig.json"], topology: false }));
  const generated = await execute([process.execPath, tool, "--root", root, "--contract", join(root, "contract.json")], root, 15000);
  expect(generated.exitCode).toBe(0);
  const inventory = join(root, "inventory.json");
  writeFileSync(inventory, generated.stdout);
  return { root, inventory, files };
}

export function replaceArguments(argv: readonly string[], alter: readonly string[]): string[] {
  const result = [...argv];
  for (let index = 0; index < alter.length; index += 2) {
    const key = alter[index], value = alter[index + 1];
    if (!key || !value) throw new FixtureError("Expected argument replacement pair");
    result[result.indexOf(key) + 1] = value;
  }
  return result;
}

function assertCandidateCounts(report: RecordValue, results: RecordValue[]): void {
  for (const row of rows(report.census).map(record)) {
    const candidates = results.filter((result) => result.path === row.path);
    const total = rows(row.operators).map(record).reduce((sum, op) => sum + Number(op.candidates), 0);
    expect(candidates).toHaveLength(total);
  }
  for (const [outcome, count] of Object.entries(record(report.counts)))
    expect(results.filter((result) => result.outcome === outcome)).toHaveLength(Number(count));
}
function assertSelectedResult(result: RecordValue): void {
  expect(result.replacementSha256).toBe(sha256(String(result.replacement)));
  expect(result.id).toBe(sha256(`${result.path}\0${result.startOffset}\0${result.endOffset}\0${result.replacementSha256}`));
  if (["killed", "survived"].includes(String(result.outcome))) expect(record(result.coverage).reached).toBe(true);
  if (result.outcome === "noCoverage") expect(record(result.coverage).reached).toBe(false);
}
export function reportResults(report: RecordValue): RecordValue[] {
  if (!report.results) return [];
  const results = rows(report.results).map(record);
  const selected = results.filter((row) => row.selected === true);
  assertCandidateCounts(report, results);
  for (const result of selected) assertSelectedResult(result);
  return selected;
}

function reportFields(report: RecordValue, keys: readonly string[]): RecordValue {
  return Object.fromEntries(keys.map((key) => [key, report[key] ?? null]));
}
export function mutationEvidence(report: RecordValue, selected: RecordValue[]): RecordValue {
  return {
    ...reportFields(report, ["full", "complete", "counts", "selectedCounts", "error", "errors", "cleanupVerified"]),
    selected: selected.map((row) => reportFields(row, ["id", "operator", "outcome", "reason", "assertionIdentities", "restored"])),
    report,
  };
}

function assertBehavioralKill(result: { code: number | null; selected: RecordValue[] }): void {
  expect(result.code).toBe(0);
  expect(result.selected[0]?.outcome).toBe("killed");
  expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(1);
}
const select = (family: string) => ["--target", "src/a.ts", "--operator", family, "--limit", "1"];

export function mutationFixture(scenario: string) {
  const roots: string[] = [], evidence: RecordValue[] = [];
  const tool = process.env.QUALITY_INVENTORY_TOOL ?? join(import.meta.dir, "quality-inventory.ts");
  const decision = process.env.QUALITY_MUTATION_DECISION ?? join(import.meta.dir, "conformance/quality-mutation-contract.json");
  const dependencyRoot = mutationDependencies();
  const dependencies = process.env.QUALITY_MUTATION_DEPENDENCIES ?? dependencyRoot;
  const runner = join(import.meta.dir, "run-quality-mutations.ts");
  const pins = { tool: sha256(readFileSync(tool)), decision: sha256(readFileSync(decision)) };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  afterAll(() => {
    rmSync(dependencyRoot, { recursive: true, force: true });
    expect(sha256(readFileSync(tool))).toBe(pins.tool);
    expect(sha256(readFileSync(decision))).toBe(pins.decision);
    const path = process.env.QUALITY_MUTATION_EVIDENCE;
    if (path) writeFileSync(`${path}.${scenario}.json`, JSON.stringify({ runtime: Bun.version, toolSha256: pins.tool, decisionSha256: pins.decision, cases: evidence }, null, 2));
  });
  const fixture = (source: string, assertion: string, additions: Record<string, string> = {}) => createFixture(tool, roots, source, assertion, additions);
  async function invoke(input: Fixture, name: string, args: string[] = [], alter: string[] = []) {
    const paths = { contract: join(input.root, "contract.json"), inventory: input.inventory, decision, "inventory-tool": tool };
    const base = [process.execPath, runner, "--root", input.root, "--dependencies", dependencies];
    for (const [key, path] of Object.entries(paths)) base.push(`--${key}`, path, `--${key}-sha256`, sha256(readFileSync(path)));
    base.push("--python", process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3");
    const argv = [...replaceArguments(base, alter), ...args];
    const receipt = await execute(argv, input.root, 90000);
    expect(receipt.timedOut).toBe(false);
    expect(receipt.overflow).toBe(false);
    expect(receipt.signal).toBeNull();
    if (!receipt.stdout || !receipt.stdout.trim().startsWith("{")) console.error("DEBUG-RECEIPT", JSON.stringify({ stdout: receipt.stdout, stderr: receipt.stderr }));
    const report = record(decode(receipt.stdout));
    expect(report.exitCode).toBe(receipt.exitCode);
    expect(report.globalZero).toBe(false);
    const selected = reportResults(report);
    evidence.push({ ...mutationEvidence(report, selected), name, exitCode: receipt.exitCode, runtime: Bun.version, stdoutSha256: receipt.stdoutSha256, stderrSha256: receipt.stderrSha256, argv, fixture: input.files, runnerSha256: sha256(readFileSync(runner)) });
    return { report, selected, code: receipt.exitCode };
  }
  return { fixture, invoke, select, assertBehavioralKill, record, rows, evidence, tool, decision, runner, dependencies, FixtureError };
}
