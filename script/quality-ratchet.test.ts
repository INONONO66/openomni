import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "./quality-ci-input";
import { mergeMeasurements, normalizeTypes } from "./quality-ci-receipt";
import { decodeJson } from "./quality-inventory";
import {
  baselineAt,
  changedFiles,
  changedSources,
  growth,
  productionSource,
  ratchetMain,
  readExecuted,
  regressions,
  touchedLines,
  type Change,
} from "./quality-ratchet";

const row = {
  gate: "publisher" as const,
  path: "packages/a/src/event.ts",
  line: 1,
  symbol: "Ready",
  value: 1,
};
const snapshot = (findings = [row]) => ({
  version: 1 as const,
  complete: true as const,
  analyzed: ["publisher" as const],
  inventory: [row.path],
  findings,
});

test("ratchets only shrink; new findings, value growth and findings in modified files fail", () => {
  const base = snapshot();
  expect(regressions(base, snapshot([]), new Set())).toEqual([]);
  expect(regressions(base, base, new Set())).toEqual([]);
  for (const current of [
    snapshot([{ ...row, value: 2 }]),
    snapshot([row, row]),
    snapshot([{ ...row, symbol: "Other" }]),
  ])
    expect(regressions(base, current, new Set()).length).toBeGreaterThan(0);
  expect(regressions(base, base, new Set([row.path]))).toEqual([row]);
  expect(regressions(base, snapshot([{ ...row, line: 9 }]), new Set())).toEqual([]);
  expect(() => regressions(base, { ...base, inventory: [] }, new Set())).toThrow();
  expect(() => regressions(base, { ...base, analyzed: [] }, new Set())).toThrow();
});

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
type Gate = (typeof gates)[number];
type Finding = ReturnType<typeof growth>[number];
const oldPath = "packages/a/src/old.ts";
const newPath = "packages/a/src/new.ts";
const otherPath = "packages/a/src/other.ts";
const receipt = (findings: Finding[], analyzed: readonly Gate[] = gates) => ({
  version: 1 as const,
  complete: true as const,
  analyzed: [...analyzed],
  inventory: [oldPath, newPath, otherPath, "packages/a/test/new.test.ts"],
  findings,
});
const whole: Change["ranges"] = [{ start: 1, count: Number.MAX_SAFE_INTEGER }];
const moved: Change = { path: newPath, previous: oldPath, ranges: [{ start: 10, count: 3 }] };
const none = new Map<string, Map<number, number>>();
const at = (gate: Gate, path: string, symbol: string, value: number, line = 1): Finding => ({
  gate,
  path,
  line,
  symbol,
  value,
});

test("a moved file inherits the baseline recorded under its Git base path", () => {
  const base = receipt([at("publisher", oldPath, "Ready", 1), at("export", oldPath, "run", 1)]);
  const current = receipt([at("publisher", newPath, "Ready", 1), at("export", newPath, "run", 1)]);
  expect(growth(base, current, [moved], none)).toEqual([]);
  // Mutation: the same file treated as added owes every finding.
  expect(growth(base, current, [{ ...moved, previous: null, ranges: whole }], none)).toHaveLength(2);
  // Mutation: one more publisher finding than the base path recorded.
  const doubled = receipt([...current.findings, at("publisher", newPath, "Ready", 1, 9)]);
  expect(growth(base, doubled, [moved], none).map((f) => f.gate)).toEqual(["publisher", "publisher"]);
});

test("pre-existing complexity inside a touched function is not growth; a worse metric is", () => {
  const base = receipt([at("cyclomatic", oldPath, "FunctionDeclaration:run", 12, 10)]);
  const run = { ...at("cyclomatic", newPath, "FunctionDeclaration:run", 12, 10), endLine: 20 };
  const same = receipt([run]);
  expect(growth(base, same, [moved], none)).toEqual([]);
  const worse = receipt([{ ...run, value: 13 }]);
  expect(growth(base, worse, [moved], none)).toEqual(worse.findings);
  const another = receipt([...same.findings, at("cyclomatic", newPath, "FunctionDeclaration:other", 11, 30)]);
  expect(growth(base, another, [moved], none)).toEqual(another.findings.slice(1));
});

test("anonymous functions compare by their per-file value multiset, not byte offsets", () => {
  const base = receipt([
    at("crap", oldPath, "ArrowFunction:<anonymous@10>", 156),
    at("crap", oldPath, "ArrowFunction:<anonymous@90>", 30),
  ]);
  const first = at("crap", newPath, "ArrowFunction:<anonymous@40>", 156);
  const second = at("crap", newPath, "ArrowFunction:<anonymous@400>", 30);
  const shifted = receipt([first, second], ["crap"]);
  const crapOnly = { ...base, analyzed: ["crap" as const] };
  expect(growth(crapOnly, shifted, [moved], none)).toEqual([]);
  const worse = receipt([first, { ...second, value: 31 }], ["crap"]);
  expect(growth(crapOnly, worse, [moved], none)).toEqual(worse.findings);
});

test("clone clusters are identified by token hash alone and reported where the PR touched them", () => {
  const base = receipt([at("productionClones", otherPath, "hash-a", 87), at("productionClones", oldPath, "hash-a", 87)]);
  const relocated = receipt([at("productionClones", otherPath, "hash-a", 87), at("productionClones", newPath, "hash-a", 87)]);
  expect(growth(base, relocated, [moved], none)).toEqual([]);
  const extra = at("productionClones", newPath, "hash-a", 87, 50);
  const third = receipt([...relocated.findings, extra]);
  expect(growth(base, third, [moved], none)).toEqual([...relocated.findings.slice(1), extra]);
  const fresh = receipt([...relocated.findings, at("productionClones", otherPath, "hash-b", 50)]);
  expect(growth(base, fresh, [moved], none)).toEqual(fresh.findings.slice(2));
});

test("type findings: foreign reach is not owned growth; owned top types on changed lines always fail", () => {
  const base = receipt([at("type", oldPath, "unknown:value", 1, 5)]);
  const foreign = { ...at("type", newPath, "unknown:cause", 1, 11), origin: "foreign" as const };
  expect(growth(base, receipt([foreign]), [moved], none)).toEqual([]);
  expect(growth(base, receipt([{ ...foreign, origin: "owned" }]), [moved], none)).toHaveLength(1);
  // An unlabelled current row is owned (fail closed); an unlabelled baseline row still limits.
  expect(growth(base, receipt([{ ...at("type", newPath, "unknown:cause", 1, 11) }]), [moved], none)).toHaveLength(1);
  const carried = { ...at("type", newPath, "unknown:value", 1, 5), origin: "owned" as const };
  expect(growth(base, receipt([carried]), [moved], none)).toEqual([]);
  expect(growth(base, receipt([{ ...carried, line: 10 }]), [moved], none)).toEqual([{ ...carried, line: 10 }]);
  expect(growth(base, receipt([{ ...carried, line: 13 }]), [moved], none)).toEqual([]);
  expect(growth(base, receipt([carried]), [{ ...moved, ranges: whole }], none)).toEqual([carried]);
});

test("touched production lines must execute natively; test sources and untouched lines are exempt", () => {
  const base = receipt([]);
  const current = receipt([]);
  const executed = new Map([[newPath, new Map([[10, 1], [11, 0], [20, 0]])]]);
  expect(growth(base, current, [moved], executed)).toEqual([
    { gate: "coverage", path: newPath, line: 11, symbol: "unexecuted-line", value: 1 },
  ]);
  expect(growth(base, current, [{ ...moved, ranges: whole }], executed).map((f) => f.line)).toEqual([11, 20]);
  const test = { path: "packages/a/test/new.test.ts", previous: null, ranges: whole };
  expect(growth(base, current, [test], new Map([[test.path, new Map([[1, 0]])]]))).toEqual([]);
  // Never loaded by a selected lane: every measured statement of the file is unexecuted.
  const statements = [at("coverage", newPath, "unproven-statement:a", 1, 1), at("coverage", newPath, "unproven-statement:b", 1, 2)];
  expect(growth(base, receipt(statements), [moved], none)).toEqual(statements);
  expect(growth(base, receipt([]), [moved], none)).toEqual([]);
  // Proof-bit statement findings themselves are no longer ratcheted per hash.
  expect(growth(base, receipt(statements), [moved], executed)).toEqual([
    { gate: "coverage", path: newPath, line: 11, symbol: "unexecuted-line", value: 1 },
  ]);
  const withoutCoverage = gates.filter((gate) => gate !== "coverage");
  expect(growth(receipt([], withoutCoverage), receipt([], withoutCoverage), [moved], executed)).toEqual([]);
});

test("CRAP growth counts only where the function has natively unexecuted lines", () => {
  const base = receipt([]);
  const crap = { ...at("crap", newPath, "FunctionDeclaration:run", 110, 10), endLine: 14 };
  const current = receipt([crap]);
  const executed = new Map([[newPath, new Map([[10, 3], [12, 1], [14, 2]])]]);
  expect(growth(base, current, [moved], executed)).toEqual([]);
  // An unexecuted line inside the function but outside the PR's hunks still makes CRAP growth real.
  const partial = new Map([[newPath, new Map([[10, 3], [12, 1], [14, 0]])]]);
  expect(growth(base, current, [moved], partial)).toEqual([crap]);
  expect(growth(base, current, [moved], none)).toEqual([crap]);
  const crapOnly = ["crap"] as const;
  expect(growth(receipt([], crapOnly), receipt([crap], crapOnly), [moved], new Map([[newPath, new Map([[12, 1]])]]))).toEqual([crap]);
});

test("production sources are production and tooling code, never tests or fixtures", () => {
  expect(productionSource("packages/a/src/x.ts")).toBe(true);
  expect(productionSource("script/quality-ratchet.ts")).toBe(true);
  expect(productionSource("script/quality-ratchet.test.ts")).toBe(false);
  expect(productionSource("packages/a/test/helpers/x.ts")).toBe(false);
  expect(productionSource("script/fixtures/x.ts")).toBe(false);
  expect(productionSource("packages/a/dist/x.js")).toBe(false);
});

function commit(root: string, message: string) {
  for (const args of [
    ["init", "-q"],
    ["add", "-A", "."],
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", message],
  ]) {
    // A fixture-only commit establishes a real comparison tree; never a product commit.
    expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
  }
}
const lines = (count: number, prefix = "line") => {
  let text = "";
  for (let index = 0; index < count; index++) text += `export const ${prefix}${index} = ${index};\n`;
  return text;
};

test("Git changes are rename-aware and hunk-anchored; the CLI applies growth, not path identity", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-ratchet-git-"));
  try {
    mkdirSync(join(root, "script/generated"), { recursive: true });
    writeFileSync(join(root, "script/old.ts"), lines(20));
    writeFileSync(join(root, "script/edited.ts"), lines(5, "edited"));
    writeFileSync(join(root, "script/gone.ts"), "export const gone = 1;\n");
    writeFileSync(join(root, "script/schema.sql"), "create table fixture (id integer primary key);\n");
    writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
    writeFileSync(
      join(root, "contract.json"),
      JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false }),
    );
    const finding = { ...row, path: "script/old.ts", line: 7 };
    const original = {
      ...snapshot([finding]),
      analyzed: ["publisher", "type", "coverage"] as const,
      inventory: ["script/edited.ts", "script/gone.ts", "script/old.ts"],
    };
    writeFileSync(join(root, "baseline.json"), JSON.stringify(original));
    commit(root, "fixture");
    // Rename with one changed line (95% similar), edit, add, untracked, generated, delete.
    writeFileSync(join(root, "script/moved.ts"), lines(20).replace("line12 = 12", "line12 = 99"));
    rmSync(join(root, "script/old.ts"));
    rmSync(join(root, "script/gone.ts"));
    writeFileSync(join(root, "script/edited.ts"), lines(5, "edited").replace("edited1 = 1", "edited1 = 2"));
    writeFileSync(join(root, "script/new.ts"), "export const added = 1;\n");
    writeFileSync(join(root, "script/generated/out.ts"), "export const generated = 1;\n");
    commit(root, "moved");
    writeFileSync(join(root, "script/untracked.ts"), "export const untracked = 1;\n");
    const changes = changedFiles(root, "HEAD~1");
    expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "script/edited.ts", previous: "script/edited.ts" },
      { path: "script/moved.ts", previous: "script/old.ts" },
      { path: "script/new.ts", previous: null },
      { path: "script/untracked.ts", previous: null },
    ]);
    expect([...changedSources(root, "HEAD~1")].sort()).toEqual(changes.map((c) => c.path));
    const touched = (path: string, previous: string | null) => touchedLines(root, "HEAD~1", { path, previous });
    expect(touched("script/moved.ts", "script/old.ts")).toEqual([{ start: 13, count: 1 }]);
    expect(touched("script/edited.ts", "script/edited.ts")).toEqual([{ start: 2, count: 1 }]);
    expect(touched("script/new.ts", null)).toEqual(whole);

    const inventory = ["script/edited.ts", "script/moved.ts", "script/new.ts", "script/untracked.ts"];
    const carried = { ...finding, path: "script/moved.ts" };
    const current = { ...original, inventory, findings: [carried] };
    const coverage = (moved: { line: number; hits: number }[]) => ({
      run: 1,
      receipts: [
        { lane: "script", files: [{ path: "script/moved.ts", lines: moved }, { path: "script/edited.ts", lines: [{ line: 2, hits: 4 }] }] },
        { lane: "script", files: [{ path: "script/new.ts", lines: [{ line: 1, hits: 1 }] }, { path: "script/untracked.ts", lines: [{ line: 1, hits: 1 }] }] },
      ],
    });
    writeFileSync(join(root, "evidence.json"), JSON.stringify(coverage([{ line: 13, hits: 1 }])));
    const args = (extra: string[]) => [
      "--root", root, "--base", "HEAD~1", "--baseline", "baseline.json",
      "--current", "current.json", "--contract", "contract.json", ...extra,
    ];
    const invoke = (extra: string[] = ["--coverage", "evidence.json"]) => ratchetMain(args(extra));
    const write = (value: object) => writeFileSync(join(root, "current.json"), JSON.stringify(value));
    write(current);
    expect(invoke()).toBe(0);
    // Without --coverage the bundle's coverage.json beside current.json is the evidence.
    expect(invoke([])).toBe(2);
    writeFileSync(join(root, "coverage.json"), JSON.stringify(coverage([{ line: 13, hits: 1 }])));
    expect(invoke([])).toBe(0);
    rmSync(join(root, "coverage.json"));
    write({ ...current, findings: [carried, { ...carried, line: 1 }] });
    expect(invoke()).toBe(1);
    write({ ...current, findings: [carried, { ...carried, gate: "type", symbol: "unknown:x", line: 1 }] });
    expect(invoke()).toBe(2);
    write({ ...current, findings: [carried, { ...carried, gate: "type", symbol: "unknown:x", line: 1, origin: "foreign" }] });
    expect(invoke()).toBe(0);
    write({ ...current, findings: [carried, { ...carried, gate: "type", symbol: "unknown:x", line: 13, origin: "owned" }] });
    // The command-line entry reports each violation as one line before the JSON summary.
    const owned = Bun.spawnSync([process.execPath, join(import.meta.dir, "quality-ratchet.ts"), ...args(["--coverage", "evidence.json"])]);
    expect(owned.exitCode).toBe(1);
    expect(owned.stdout.toString().trim().split("\n").slice(0, -1)).toEqual(["type script/moved.ts:13 unknown:x 1"]);
    write(current);
    writeFileSync(join(root, "evidence.json"), JSON.stringify(coverage([{ line: 13, hits: 0 }, { line: 5, hits: 0 }])));
    const unexecuted = Bun.spawnSync([process.execPath, join(import.meta.dir, "quality-ratchet.ts"), ...args(["--coverage", "evidence.json"])]);
    expect(unexecuted.exitCode).toBe(1);
    expect(unexecuted.stdout.toString().trim().split("\n").slice(0, -1)).toEqual([
      "coverage script/moved.ts:13 unexecuted-line 1",
    ]);
    write({ ...current, complete: false });
    expect(invoke()).toBe(2);
    for (const malformed of [{ ...carried, line: 0 }, { ...carried, endLine: 6 }, { ...carried, count: 0 }]) {
      write({ ...current, findings: [malformed] });
      expect(invoke()).toBe(2);
    }
    // A first baseline must equal the measured debt, including added source.
    const added = { ...row, path: "script/new.ts" };
    const initial = { ...current, findings: [added] };
    writeFileSync(join(root, "initial.json"), JSON.stringify(initial));
    const admit = () => invoke(["--coverage", "evidence.json", "--baseline", "initial.json"]);
    write(initial);
    expect(admit()).toBe(0);
    write({ ...initial, findings: [] });
    expect(admit()).toBe(2);
    write({ ...initial, findings: [added, added] });
    expect(admit()).toBe(1);
    // A store measurement's inventory also enumerates migration sources and the live schema.
    const stored = { ...initial, analyzed: [...initial.analyzed, "store"], inventory: [...inventory, "script/schema.sql", "sqlite_schema"] };
    writeFileSync(join(root, "stored.json"), JSON.stringify(stored));
    write(stored);
    expect(invoke(["--coverage", "evidence.json", "--baseline", "stored.json"])).toBe(0);
    write({ ...stored, inventory });
    expect(invoke(["--coverage", "evidence.json", "--baseline", "stored.json"])).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthetic regression fails closed end to end: a measured owned top type in a PR hunk stops the ratchet", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-ratchet-regression-"));
  try {
    mkdirSync(join(root, "script"), { recursive: true });
    mkdirSync(join(root, "node_modules/dep"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    writeFileSync(join(root, "node_modules/dep/index.d.ts"), "export declare function make(): { nested: unknown };\n");
    writeFileSync(join(root, "script/lib.ts"), "export function double(value: number) { return value * 2; }\n");
    writeFileSync(
      join(root, "script/tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: [] },
        include: ["*.ts"],
      }),
    );
    writeFileSync(
      join(root, "contract.json"),
      JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false }),
    );
    // The real census measures the fixture; its receipt is what CI writes to current.json.
    const measure = () => {
      const identity = fingerprint(root, "contract.json");
      writeFileSync(join(root, "inventory.json"), JSON.stringify(identity.inventory));
      const census = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "check-types-census.ts"), "--root", root, "--contract", "contract.json", "--inventory", "inventory.json"],
        { stdout: "pipe", stderr: "pipe", timeout: 60_000 },
      );
      // The census exits 1 when a complete receipt has violations; 2 is a measurement failure.
      expect([0, 1]).toContain(census.exitCode);
      return mergeMeasurements(identity.paths, [normalizeTypes(decodeJson(census.stdout.toString()), identity)]);
    };
    const baseline = measure();
    expect(baseline.findings).toEqual([]);
    writeFileSync(join(root, "baseline.json"), JSON.stringify(baseline));
    commit(root, "fixture");
    const ratchet = () => {
      writeFileSync(join(root, "current.json"), JSON.stringify(measure()));
      const child = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "quality-ratchet.ts"), "--root", root, "--base", "HEAD", "--baseline", "baseline.json", "--current", "current.json", "--contract", "contract.json"],
        { stdout: "pipe", stderr: "pipe", timeout: 60_000 },
      );
      return { status: child.exitCode, lines: child.stdout.toString().trim().split("\n").slice(0, -1) };
    };
    expect(ratchet()).toEqual({ status: 0, lines: [] });
    // A touched line whose only top type is reached through the dependency's declaration is not owned growth.
    appendFileSync(join(root, "script/lib.ts"), 'import { make } from "dep";\nexport const reached = make();\n');
    expect(ratchet()).toEqual({ status: 0, lines: [] });
    // The synthetic regression: one owned `unknown` written on a new line must stop the ratchet.
    appendFileSync(join(root, "script/lib.ts"), "export function scratch(value: unknown) { return value; }\n");
    const failed = ratchet();
    expect(failed.status).toBe(1);
    expect(failed.lines.length).toBeGreaterThan(0);
    expect(failed.lines.every((line) => line.startsWith("type script/lib.ts:4 unknown:"))).toBe(true);
    expect(failed.lines).toContain("type script/lib.ts:4 unknown:value 1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native coverage evidence takes the best hit count across lanes and rejects malformed lines", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-ratchet-lcov-"));
  try {
    const path = join(root, "coverage.json");
    writeFileSync(
      path,
      JSON.stringify({
        receipts: [
          { files: [{ path: "a.ts", lines: [{ line: 1, hits: 0 }, { line: 2, hits: 1 }] }] },
          { files: [{ path: "a.ts", lines: [{ line: 1, hits: 2 }] }, { path: "b.ts", lines: [] }] },
        ],
      }),
    );
    const executed = readExecuted(path);
    expect([...(executed.get("a.ts") ?? [])]).toEqual([[1, 2], [2, 1]]);
    expect(executed.get("b.ts")?.size).toBe(0);
    writeFileSync(path, JSON.stringify({ receipts: [{ files: [{ path: "a.ts", lines: [{ line: 0, hits: 1 }] }] }] }));
    expect(() => readExecuted(path)).toThrow();
    writeFileSync(path, JSON.stringify({ receipts: [{ files: [{ path: "a.ts", lines: [{ line: 1, hits: -1 }] }] }] }));
    expect(() => readExecuted(path)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compacted baseline multiplicities cannot conceal new or higher-severity findings", () => {
  const base = { ...snapshot(), findings: [{ ...row, value: 10, count: 2 }] };
  expect(
    regressions(
      base,
      snapshot([
        { ...row, value: 9 },
        { ...row, value: 8 },
      ]),
      new Set(),
    ),
  ).toEqual([]);
  expect(regressions(base, snapshot([row, row, row]), new Set())).toHaveLength(3);
  expect(regressions(base, snapshot([{ ...row, value: 11 }]), new Set())).toHaveLength(1);
});

test("fragment baselines are read from the compared Git revision, not editable working files", () => {
  const root = mkdtempSync(join(tmpdir(), "ratchet-fragments-"));
  try {
    const { findings, ...header } = snapshot();
    writeFileSync(join(root, "index.json"), JSON.stringify({ ...header, fragments: ["rows.json"] }));
    writeFileSync(join(root, "rows.json"), JSON.stringify(findings));
    commit(root, "baseline");
    writeFileSync(join(root, "rows.json"), JSON.stringify([{ ...row, count: 2 }]));
    const prior = baselineAt(root, "index.json", "HEAD");
    const candidate = baselineAt(root, "index.json");
    expect(prior.findings).toEqual([row]);
    expect(regressions(prior, candidate, new Set())).toHaveLength(1);
    writeFileSync(join(root, "index.json"), JSON.stringify({ ...header, fragments: ["../outside.json"] }));
    expect(() => baselineAt(root, "index.json")).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
