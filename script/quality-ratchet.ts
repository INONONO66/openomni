import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildInventory,
  digest,
  category,
  readContract,
  decodeJson,
  InventoryError,
  jsonArray,
  jsonBoolean,
  jsonChoice,
  jsonLiteral,
  jsonNumber,
  jsonObject,
  jsonString,
  type Json,
} from "./quality-inventory";
import { qualitySource } from "./quality-source";
import { origins } from "./check-types-census";
import { mergeNativeLines, type NativeLines } from "./quality-native-lcov";

const gates = [
  "type",
  "publisher",
  "export",
  "store",
  "cyclomatic",
  "cognitive",
  "halstead",
  "crap",
  "productionClones",
  "testClones",
  "coverage",
  "mutation",
] as const;
let lastFailure: InventoryError | undefined;
function fail(message: string): never {
  lastFailure = new InventoryError("ratchet", "", message);
  throw lastFailure;
}
function optional<K extends string, T>(
  key: K,
  value: Json | undefined,
  parse: (value: Json) => T,
): { [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: parse(value) } as { [P in K]?: T });
}
function finding(value: Json) {
  const row = jsonObject(value, [
    "gate",
    "path",
    "line",
    "endLine",
    "symbol",
    "value",
    "count",
    "origin",
  ]);
  const result = {
    gate: jsonChoice(row.gate, gates),
    path: jsonString(row.path),
    line: jsonNumber(row.line),
    symbol: jsonString(row.symbol),
    value: jsonNumber(row.value),
    ...optional("endLine", row.endLine, jsonNumber),
    ...optional("count", row.count, jsonNumber),
    ...optional("origin", row.origin, (origin) => jsonChoice(origin, origins)),
  };
  if (
    !result.path ||
    !result.symbol ||
    !Number.isSafeInteger(result.line) ||
    result.line < 1 ||
    result.value < 0
  )
    fail("invalid finding");
  if (
    result.endLine !== undefined &&
    (!Number.isSafeInteger(result.endLine) || result.endLine < result.line)
  )
    fail("invalid finding extent");
  if (result.count !== undefined && (!Number.isSafeInteger(result.count) || result.count < 1))
    fail("invalid finding multiplicity");
  return result;
}
function parseReceipt(value: Json) {
  const input = jsonObject(value, ["version", "complete", "analyzed", "inventory", "findings", "sha256"]);
  const result = {
    version: jsonLiteral(input.version, 1),
    complete: jsonBoolean(input.complete),
    analyzed: jsonArray(input.analyzed, (gate) => jsonChoice(gate, gates)),
    inventory: jsonArray(input.inventory, jsonString),
    findings: jsonArray(input.findings, finding),
    ...optional("sha256", input.sha256, (value) => Object.fromEntries(Object.entries(jsonObject(value)).map(([path, hash]) => {
      const sha256 = jsonString(hash);
      if (!/^[a-f0-9]{64}$/.test(sha256)) fail(`invalid baseline hash: ${path}`);
      return [path, sha256];
    }))),
  };
  if (!result.complete || !result.inventory.length || !result.analyzed.length)
    fail("incomplete receipt");
  return result;
}
type Receipt = ReturnType<typeof parseReceipt>;
type Finding = ReturnType<typeof finding>;

/** Unmeasured findings are debt, not new observations. Only a matching baseline
 * content hash admits them; missing proof (including deletion) fails closed. */
export function carryUnmeasured(root: string, baseline: Receipt, current: Receipt, measured: readonly string[], globalGates: readonly Finding["gate"][] = []): Receipt {
  comparable(baseline, current);
  const scope = new Set(measured);
  const unmeasured = [...new Set([...baseline.inventory, ...current.inventory])].filter((path) => !scope.has(path));
  for (const path of unmeasured) {
    const proof = baseline.sha256?.[path];
    if (!proof) fail(`missing unchanged proof: ${path}`);
    let hash: string;
    try {
      hash = digest(readFileSync(resolve(root, path)));
    } catch {
      fail(`missing unchanged source: ${path}`);
    }
    if (hash !== proof) fail(`unchanged proof mismatch: ${path}`);
  }
  const carried = baseline.findings.filter((row) => !scope.has(row.path) && !globalGates.includes(row.gate)).flatMap((row) => {
    const { count = 1, ...finding } = row;
    return Array.from({ length: count }, () => finding);
  });
  return { ...current, inventory: [...new Set([...current.inventory, ...unmeasured])].sort(), findings: [...current.findings, ...carried] };
}

function key(row: Finding): string {
  return `${row.gate}\0${row.path}\0${row.symbol}`;
}
function groups(rows: Finding[], identity: (row: Finding) => string = key) {
  const result = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const values = result.get(identity(row)) ?? new Map<number, number>();
    const count = (values.get(row.value) ?? 0) + (row.count ?? 1);
    if (!Number.isSafeInteger(count)) fail("finding multiplicity overflow");
    values.set(row.value, count);
    result.set(identity(row), values);
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
  if (!input.complete || !input.inventory.length || !input.analyzed.length)
    fail("incomplete receipt");
  if (
    new Set(input.inventory).size !== input.inventory.length ||
    new Set(input.analyzed).size !== input.analyzed.length
  )
    fail("duplicate inventory or gate identity");
  const files = new Set(input.inventory);
  for (const row of input.findings) {
    if (!files.has(row.path) || !input.analyzed.includes(row.gate))
      fail("finding outside analyzed inventory");
  }
}
function comparable(baseline: Receipt, current: Receipt): void {
  validate(baseline);
  validate(current);
  if (
    JSON.stringify([...baseline.analyzed].sort()) !== JSON.stringify([...current.analyzed].sort())
  )
    fail("analyzed gate set changed");
}

/** Strict path-keyed dominance. This compares two recordings of the same tree
 * (baseline integrity, initial admission); PR attribution uses `growth`. */
export function regressions(
  baseline: Receipt,
  current: Receipt,
  changed: ReadonlySet<string>,
): Finding[] {
  comparable(baseline, current);
  const limits = groups(baseline.findings);
  const observed = groups(current.findings);
  return current.findings.filter((row) => {
    if (changed.has(row.path)) return true;
    const prior = limits.get(key(row)) ?? new Map<number, number>();
    const values = observed.get(key(row)) ?? new Map<number, number>();
    return grew(values, prior);
  });
}

/** One changed source: `previous` is its path in the Git base (`null` when
 * added), `ranges` the added/changed line ranges on the current side. */
export type Change = {
  path: string;
  previous: string | null;
  ranges: readonly { start: number; count: number }[];
};
/** Native LCOV hits by source path and line; absent lines are not executable. */
export type Executed = ReadonlyMap<string, ReadonlyMap<number, number>>;
const cloneGates: readonly Finding["gate"][] = ["productionClones", "testClones"];
export function productionSource(path: string): boolean {
  return qualitySource(path) && ["production", "tooling"].includes(category(path));
}
function touches(change: Change | undefined, line: number, endLine = line): boolean {
  return Boolean(
    change?.ranges.some(
      (range) => range.count > 0 && line <= range.start + range.count - 1 && endLine >= range.start,
    ),
  );
}
/** Content-anchored identity: a moved file keeps its baseline under the Git
 * base path, anonymous function offsets are erased (a per-file multiset) and
 * clone clusters are keyed by token hash alone. */
function identityOf(changes: readonly Change[]): (row: Finding) => string {
  const renamed = new Map<string, string>();
  for (const change of changes)
    if (change.previous !== null && change.previous !== change.path)
      renamed.set(change.previous, change.path);
  return (row) =>
    [
      row.gate,
      cloneGates.includes(row.gate) ? "" : (renamed.get(row.path) ?? row.path),
      row.symbol.replace(/<anonymous@\d+>/, "<anonymous>"),
    ].join("\0");
}
/** Whether a native line inside the finding's extent went unexecuted; a file
 * without any native record fails closed. */
function unexecuted(executed: Executed, row: Finding): boolean {
  const hits = executed.get(row.path);
  if (!hits) return true;
  for (const [line, count] of hits)
    if (count === 0 && line >= row.line && line <= (row.endLine ?? row.line)) return true;
  return false;
}
/** Every touched line of a production source must have executed natively. A
 * touched file never loaded by a selected lane owes all its measured statements. */
function unexecutedLines(
  current: Receipt,
  changes: readonly Change[],
  executed: Executed,
): Finding[] {
  const failures: Finding[] = [];
  for (const change of changes.filter((change) => productionSource(change.path))) {
    const hits = executed.get(change.path);
    if (!hits) {
      failures.push(
        ...current.findings.filter((row) => row.gate === "coverage" && row.path === change.path),
      );
      continue;
    }
    for (const [line, count] of hits)
      if (count === 0 && touches(change, line))
        failures.push({ gate: "coverage", path: change.path, line, symbol: "unexecuted-line", value: 1 });
  }
  return failures;
}
/** PR growth attribution by content identity rather than path. Foreign-origin
 * type reach is not owned growth; the proof-bit coverage class is replaced by
 * native line hits on touched production lines; CRAP growth counts only where
 * the function has a natively unexecuted line, because its coverage term is a
 * proof-bit lower bound that no multi-line statement can satisfy. */
export function growth(
  baseline: Receipt,
  current: Receipt,
  changes: readonly Change[],
  executed: Executed,
): Finding[] {
  comparable(baseline, current);
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const identity = identityOf(changes);
  const compared = (row: Finding) => row.gate !== "coverage" && row.origin !== "foreign";
  const limits = groups(baseline.findings.filter(compared), identity);
  const observed = groups(current.findings.filter(compared), identity);
  const lcov = current.analyzed.includes("coverage");
  const counts = (row: Finding) => row.gate !== "crap" || !lcov || unexecuted(executed, row);
  const failures: Finding[] = [];
  for (const [id, values] of observed) {
    if (!grew(values, limits.get(id) ?? new Map())) continue;
    const rows = current.findings.filter((row) => compared(row) && identity(row) === id && counts(row));
    const attributable = rows.filter((row) => byPath.has(row.path));
    failures.push(...attributable);
  }
  // The literal-zero target: an owned top type on a changed line always fails.
  failures.push(
    ...current.findings.filter(
      (row) =>
        row.gate === "type" &&
        row.origin !== "foreign" &&
        touches(byPath.get(row.path), row.line, row.endLine),
    ),
  );
  if (lcov) failures.push(...unexecutedLines(current, changes, executed));
  return [...new Set(failures)];
}

function git(root: string, args: string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd: root, timeout: 30_000 });
  if (child.exitCode !== 0) fail(child.stderr.toString());
  return child.stdout.toString();
}
export function baselineAt(root: string, path: string, ref?: string): Receipt {
  const filename = relative(root, resolve(root, path));
  if (filename.startsWith("..")) fail("baseline outside repository");
  const read = (name: string) =>
    decodeJson(
      ref ? git(root, ["show", `${ref}:${name}`]) : readFileSync(resolve(root, name), "utf8"),
    );
  const document = jsonObject(read(filename), [
    "version",
    "complete",
    "analyzed",
    "inventory",
    "findings",
    "fragments",
    "sha256",
  ]);
  if (document.fragments === undefined) return parseReceipt(document);
  if (document.findings !== undefined) fail("baseline has two finding authorities");
  const { fragments, ...header } = document;
  const baseline = parseReceipt({ ...header, findings: [] });
  const names = jsonArray(fragments, jsonString);
  if (!names.length || new Set(names).size !== names.length) fail("invalid baseline fragments");
  baseline.findings = names.flatMap((fragment) => {
    const target = relative(root, resolve(root, dirname(filename), fragment));
    if (target.startsWith("..") || fragment.startsWith("/") || fragment.split("/").includes(".."))
      fail("fragment outside baseline directory");
    return jsonArray(read(target), finding);
  });
  validate(baseline);
  return baseline;
}
/** Rename-aware change list: Git's similarity pairing decides which base path
 * a current file inherits its recorded findings from. Deleted paths simply
 * stop matching. Untracked owned sources are added files. */
export function changedFiles(root: string, base: string): Omit<Change, "ranges">[] {
  const revision = git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const status = git(root, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    "--diff-filter=ACMRT",
    revision,
    "--",
  ]).split("\0");
  const result = new Map<string, string | null>();
  for (let index = 0; index + 1 < status.length; ) {
    const [code = "", first = ""] = [status[index], status[index + 1]];
    if (code.startsWith("R")) {
      result.set(status[index + 2] ?? "", first);
      index += 3;
    } else {
      result.set(first, code === "A" ? null : first);
      index += 2;
    }
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const path of untracked.split("\0")) if (path && !result.has(path)) result.set(path, null);
  return [...result]
    .filter(([path]) => qualitySource(path))
    .map(([path, previous]) => ({ path, previous }));
}
export function changedSources(root: string, base: string): Set<string> {
  return new Set(changedFiles(root, base).map((change) => change.path));
}
/** Current-side line ranges added or modified relative to the base path. An
 * added file is entirely new. */
export function touchedLines(
  root: string,
  base: string,
  change: Omit<Change, "ranges">,
): Change["ranges"] {
  if (change.previous === null) return [{ start: 1, count: Number.MAX_SAFE_INTEGER }];
  const paths = [...new Set([change.previous, change.path])];
  const diff = git(root, [
    "diff",
    "--unified=0",
    "--no-ext-diff",
    "--find-renames",
    base,
    "--",
    ...paths,
  ]);
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((match) => ({ start: Number(match[1]), count: Number(match[2] ?? 1) }))
    .filter((range) => range.count > 0);
}
/** The measurement's saved native coverage: `{ receipts: [{ files: [{ path, lines }] }] }`. */
export function readExecuted(path: string): Executed {
  const document = jsonObject(decodeJson(readFileSync(path, "utf8")));
  const records: NativeLines[] = [];
  for (const receipt of jsonArray(document.receipts, jsonObject)) {
    for (const file of jsonArray(receipt.files, jsonObject)) {
      const source = jsonString(file.path);
      const lines = jsonArray(file.lines, jsonObject).map((entry) => {
        const line = jsonNumber(entry.line), hits = jsonNumber(entry.hits);
        if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(hits) || hits < 0)
          fail("invalid native coverage line");
        return { line, hits };
      });
      records.push({ path: source, lines });
    }
  }
  const result = new Map<string, Map<number, number>>();
  for (const file of mergeNativeLines(records)) result.set(file.path, new Map(file.lines.map((row) => [row.line, row.hits])));
  return result;
}
/** The complete source inventory a current receipt must enumerate. */
function expectedInventory(root: string, contract: string, analyzed: readonly string[]): string[] {
  const inventory = buildInventory(root, readContract(resolve(root, contract)));
  const expected = inventory.files.map((file) => file.path).filter(qualitySource);
  if (analyzed.includes("store")) {
    expected.push(
      ...inventory.files
        .filter((file) => file.language === "sql" && file.category === "migration")
        .map((file) => file.path),
      "sqlite_schema",
    );
  }
  return expected.sort();
}
/** Whether the baseline already exists in the Git base. An established baseline
 * may only shrink; an initial one must equal the measured findings. */
function establishedBaseline(root: string, base: string, path: string, baseline: Receipt, current: Receipt): boolean {
  const baselinePath = relative(root, resolve(root, path));
  if (baselinePath.startsWith("..")) fail("baseline outside repository");
  const established = Boolean(git(root, ["ls-tree", "--name-only", base, "--", baselinePath]).trim());
  if (established) {
    if (regressions(baselineAt(root, path, base), baseline, new Set()).length) fail("recorded baseline grew");
  } else if (regressions(current, baseline, new Set()).length) {
    fail("initial baseline exceeds measured findings");
  }
  return established;
}
/** Native line evidence: `--coverage`, or the measurement bundle's coverage.json beside current.json. */
function nativeEvidence(root: string, current: string, coverage: string | undefined, analyzed: readonly string[]): Executed {
  const evidence = coverage ? resolve(root, coverage) : resolve(root, dirname(current), "coverage.json");
  return analyzed.includes("coverage") ? readExecuted(evidence) : new Map();
}
export function ratchetMain(argv = process.argv.slice(2)): number {
  lastFailure = undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        root: { type: "string", default: process.cwd() },
        base: { type: "string", default: "origin/main" },
        baseline: { type: "string" },
        current: { type: "string" },
        coverage: { type: "string" },
        contract: { type: "string", default: "script/conformance/quality-contract.json" },
      },
    });
    if (!values.baseline || !values.current)
      fail("--baseline and --current complete receipts are required");
    const read = (path: string) =>
      parseReceipt(decodeJson(readFileSync(resolve(values.root, path), "utf8")));
    const baseline = baselineAt(values.root, values.baseline),
      current = read(values.current);
    if (current.findings.some((row) => row.count !== undefined))
      fail("current findings require exact individual locations");
    if (current.findings.some((row) => row.gate === "type" && row.origin === undefined))
      fail("current type findings require an origin");
    const expected = expectedInventory(values.root, values.contract, current.analyzed);
    if (JSON.stringify([...current.inventory].sort()) !== JSON.stringify(expected))
      fail("current source inventory is incomplete");
    const established = establishedBaseline(values.root, values.base, values.baseline, baseline, current);
    const executed = nativeEvidence(values.root, values.current, values.coverage, current.analyzed);
    // Admission establishes the first measured baseline, not zero convergence.
    // Once present in the Git base, growth is attributed to the PR's changes.
    const failures = established
      ? growth(
          baseline,
          current,
          changedFiles(values.root, values.base).map((change) => ({
            ...change,
            ranges: touchedLines(values.root, values.base, change),
          })),
          executed,
        )
      : regressions(baseline, current, new Set());
    failures.sort((a, b) => key(a).localeCompare(key(b)) || a.line - b.line);
    // Native sites can share a rendered location (for example several AST
    // offsets on one line). Keep their debt multiset above; report the row set.
    const rows = new Set(failures.map((row) => `${row.gate} ${row.path}:${row.line} ${row.symbol} ${row.value}`));
    for (const row of rows) console.log(row);
    console.log(
      JSON.stringify({ complete: true, violations: rows.size, analyzed: current.analyzed }),
    );
    return Number(failures.length > 0);
  } catch {
    const failure = lastFailure ?? { message: "invalid receipt, baseline, source inventory or Git comparison" };
    console.error(`incomplete ratchet: ${failure.message}`);
    return 2;
  }
}
if (import.meta.main) process.exitCode = ratchetMain();
