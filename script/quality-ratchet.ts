import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildInventory, readContract, decodeJson, InventoryError, jsonArray, jsonBoolean, jsonChoice, jsonLiteral, jsonNumber, jsonObject, jsonString, type Json } from "./quality-inventory";
import { qualitySource } from "./quality-source";

const gates = ["type", "publisher", "export", "store", "cyclomatic", "cognitive", "halstead", "crap", "productionClones", "testClones", "coverage", "mutation"] as const;
function fail(message: string): never { throw new InventoryError("ratchet", "", message); }
function finding(value: Json) {
  const row = jsonObject(value, ["gate", "path", "line", "endLine", "symbol", "value", "count"]);
  const result = { gate: jsonChoice(row.gate, gates), path: jsonString(row.path), line: jsonNumber(row.line), symbol: jsonString(row.symbol), value: jsonNumber(row.value), ...(row.endLine === undefined ? {} : { endLine: jsonNumber(row.endLine) }), ...(row.count === undefined ? {} : { count: jsonNumber(row.count) }) };
  if (!result.path || !result.symbol || !Number.isSafeInteger(result.line) || result.line < 1 || result.value < 0) fail("invalid finding");
  if (result.endLine !== undefined && (!Number.isSafeInteger(result.endLine) || result.endLine < result.line)) fail("invalid finding extent");
  if (result.count !== undefined && (!Number.isSafeInteger(result.count) || result.count < 1)) fail("invalid finding multiplicity");
  return result;
}
function parseReceipt(value: Json) {
  const input = jsonObject(value, ["version", "complete", "analyzed", "inventory", "findings"]);
  const result = {
    version: jsonLiteral(input.version, 1), complete: jsonBoolean(input.complete),
    analyzed: jsonArray(input.analyzed, (gate) => jsonChoice(gate, gates)),
    inventory: jsonArray(input.inventory, jsonString), findings: jsonArray(input.findings, finding),
  };
  if (!result.complete || !result.inventory.length || !result.analyzed.length) fail("incomplete receipt");
  return result;
}
type Receipt = ReturnType<typeof parseReceipt>;
type Finding = ReturnType<typeof finding>;

function key(row: Finding): string {
  return `${row.gate}\0${row.path}\0${row.symbol}`;
}
function groups(rows: Finding[]): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const values = result.get(key(row)) ?? new Map<number, number>();
    const count = (values.get(row.value) ?? 0) + (row.count ?? 1);
    if (!Number.isSafeInteger(count)) fail("finding multiplicity overflow");
    values.set(row.value, count);
    result.set(key(row), values);
  }
  return result;
}
function countAt(values: ReadonlyMap<number, number>, minimum: number): number {
  let count = 0;
  for (const [value, size] of values) if (value >= minimum) count += size;
  if (!Number.isSafeInteger(count)) fail("finding multiplicity overflow");
  return count;
}
function grew(current: ReadonlyMap<number, number>, prior: ReadonlyMap<number, number>): boolean {
  return [...current.keys()].some((value) => countAt(current, value) > countAt(prior, value));
}

function validate(input: Receipt): void {
  if (!input.complete || !input.inventory.length || !input.analyzed.length) fail("incomplete receipt");
  if (new Set(input.inventory).size !== input.inventory.length || new Set(input.analyzed).size !== input.analyzed.length)
    fail("duplicate inventory or gate identity");
  const files = new Set(input.inventory);
  for (const row of input.findings) {
    if (!files.has(row.path) || !input.analyzed.includes(row.gate)) fail("finding outside analyzed inventory");
  }
}

export function regressions(baseline: Receipt, current: Receipt, changed: ReadonlySet<string>): Finding[] {
  validate(baseline);
  validate(current);
  if (JSON.stringify([...baseline.analyzed].sort()) !== JSON.stringify([...current.analyzed].sort()))
    fail("analyzed gate set changed");
  const limits = groups(baseline.findings);
  const observed = groups(current.findings);
  return current.findings.filter((row) => {
    if (changed.has(row.path)) return true;
    const prior = limits.get(key(row)) ?? new Map<number, number>();
    const values = observed.get(key(row)) ?? new Map<number, number>();
    return grew(values, prior);
  });
}

function git(root: string, args: string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd: root, timeout: 30_000 });
  if (child.exitCode !== 0) fail(child.stderr.toString());
  return child.stdout.toString();
}
export function baselineAt(root: string, path: string, ref?: string): Receipt {
  const filename = relative(root, resolve(root, path));
  if (filename.startsWith("..")) fail("baseline outside repository");
  const read = (name: string) => decodeJson(ref ? git(root, ["show", `${ref}:${name}`]) : readFileSync(resolve(root, name), "utf8"));
  const document = jsonObject(read(filename), ["version", "complete", "analyzed", "inventory", "findings", "fragments"]);
  if (document.fragments === undefined) return parseReceipt(document);
  if (document.findings !== undefined) fail("baseline has two finding authorities");
  const { fragments, ...header } = document;
  const baseline = parseReceipt({ ...header, findings: [] });
  const names = jsonArray(fragments, jsonString);
  if (!names.length || new Set(names).size !== names.length) fail("invalid baseline fragments");
  baseline.findings = names.flatMap((fragment) => {
    const target = relative(root, resolve(root, dirname(filename), fragment));
    if (target.startsWith("..") || fragment.startsWith("/") || fragment.split("/").includes("..")) fail("fragment outside baseline directory");
    return jsonArray(read(target), finding);
  });
  validate(baseline);
  return baseline;
}
export function changedSources(root: string, base: string): Set<string> {
  const revision = git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const tracked = git(root, ["diff", "--name-only", "--no-renames", "-z", "--diff-filter=ACMT", revision, "--"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return new Set(`${tracked}${untracked}`.split("\0").filter(qualitySource));
}
export function touchedFindings(root: string, base: string, rows: Finding[]): Finding[] {
  const result: Finding[] = [];
  for (const path of changedSources(root, base)) {
    const existing = git(root, ["ls-tree", "--name-only", base, "--", path]).trim();
    const selected = rows.filter((row) => row.path === path);
    if (!existing) { result.push(...selected); continue; }
    const diff = git(root, ["diff", "--unified=0", "--no-ext-diff", base, "--", path]);
    const ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({ start: Number(match[1]), count: Number(match[2] ?? 1) }));
    result.push(...selected.filter((row) => ranges.some((range) => range.count > 0 && row.line <= range.start + range.count - 1 && (row.endLine ?? row.line) >= range.start)));
  }
  return result;
}
export function ratchetMain(argv = process.argv.slice(2)): number {
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: {
      root: { type: "string", default: process.cwd() }, base: { type: "string", default: "origin/main" },
      baseline: { type: "string" }, current: { type: "string" },
      contract: { type: "string", default: "script/conformance/quality-contract.json" },
    } });
    if (!values.baseline || !values.current) fail("--baseline and --current complete receipts are required");
    const read = (path: string) => parseReceipt(decodeJson(readFileSync(resolve(values.root, path), "utf8")));
    const baseline = baselineAt(values.root, values.baseline), current = read(values.current);
    if (current.findings.some((row) => row.count !== undefined)) fail("current findings require exact individual locations");
    const inventory = buildInventory(values.root, readContract(resolve(values.root, values.contract)));
    const expected = inventory.files.map((file) => file.path).filter(qualitySource);
    if (current.analyzed.includes("store")) {
      expected.push(...inventory.files.filter((file) => file.language === "sql" && file.category === "migration").map((file) => file.path), "sqlite_schema");
    }
    expected.sort();
    if (JSON.stringify([...current.inventory].sort()) !== JSON.stringify(expected)) fail("current source inventory is incomplete");
    const baselinePath = relative(values.root, resolve(values.root, values.baseline));
    if (baselinePath.startsWith("..")) fail("baseline outside repository");
    const priorFiles = git(values.root, ["ls-tree", "--name-only", values.base, "--", baselinePath]);
    if (priorFiles.trim()) {
      const prior = baselineAt(values.root, values.baseline, values.base);
      if (regressions(prior, baseline, new Set()).length) fail("recorded baseline grew");
    }
    const global = regressions(baseline, current, new Set());
    const touched = touchedFindings(values.root, values.base, current.findings);
    const failures = [...new Set([...global, ...touched])];
    failures.sort((a, b) => key(a).localeCompare(key(b)) || a.line - b.line);
    for (const row of failures) console.log(`${row.gate} ${row.path}:${row.line} ${row.symbol} ${row.value}`);
    console.log(JSON.stringify({ complete: true, violations: failures.length, analyzed: current.analyzed }));
    return Number(failures.length > 0);
  } catch {
    console.error("incomplete ratchet: invalid receipt, baseline, source inventory or Git comparison");
    return 2;
  }
}
if (import.meta.main) process.exitCode = ratchetMain();
