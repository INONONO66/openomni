import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { coverageForMetrics, decode, exactMetric, sha256, failureExcerpt } from "./check-quality-coverage";
import { run as metrics } from "./check-quality-metrics";
import { statementCounters } from "./quality-ci-bound";
import { loadCoverage, prepare } from "./quality-metrics/coverage";
import { loadInventory } from "./quality-metrics/input";
import { parseNativeLcov } from "./quality-native-lcov";
import { joinBounds, measureStatic } from "./quality-ci-metrics";

type Json = ReturnType<typeof decode>;
class FixtureError {
	constructor(readonly message: string) { }
}
function obj(value: Json | undefined): { [key: string]: Json } {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new FixtureError("expected object");
	return value;
}
function list(value: Json | undefined): Json[] {
	if (!Array.isArray(value)) throw new FixtureError("expected array");
	return value;
}
function str(value: Json | undefined): string {
	if (typeof value !== "string") throw new FixtureError("expected string");
	return value;
}
const checker = join(import.meta.dir, "check-quality-coverage.ts");
const owner = join(import.meta.dir, "check-coverage-ratchet.ts");
const fixtures = {
	"script/subject.ts":
		"export function select(value: boolean): number { if (value) return 1; return 0; }\n",
	"script/subject.test.ts":
		'import { test, expect } from "bun:test"; import { select } from "./subject"; test("both", () => { expect(select(true)).toBe(1); expect(select(false)).toBe(0); });\n',
};
type Command = {
	id: string;
	kind: string;
	paths: string[];
	args: string[];
	expectedExitCode: number;
	runtime?: string;
};
const defaultPlan: Command[] = [
	{ id: "tests", kind: "test", paths: ["script/subject.test.ts"], args: [], expectedExitCode: 0 },
];

function fixture(sources: Record<string, string> = fixtures, commands: Command[] = defaultPlan) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "d945-test-")));
	function put(path: string, value: string): void {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), value);
	}
	for (const [path, source] of Object.entries(sources)) put(path, source);
	put("script/tsconfig.json", '{"compilerOptions":{"strict":true}}');
	const contract = {
		version: 1,
		typescript: "5.9.2",
		roots: ["script"],
		projects: ["script/tsconfig.json"],
		topology: false,
	};
	put("contract.json", JSON.stringify(contract));
	put(
		"inventory.json",
		JSON.stringify({
			version: 1,
			contractHash: sha256(JSON.stringify(contract)),
			files: Object.entries(sources)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([path, source]) => ({
					path,
					sha256: sha256(source),
					bytes: Buffer.byteLength(source),
					category: path.includes(".test.") ? "test" : "tooling",
					language: path.endsWith(".py") ? "python" : "typescript",
				})),
			historical: [],
			embedded: [],
			configurations: [
				{
					path: "script/tsconfig.json",
					sha256: sha256(readFileSync(join(root, "script/tsconfig.json"))),
				},
			],
		}),
	);
	put("plan.json", JSON.stringify({ version: 1, commands }));
	const args = [
		"--root",
		root,
		...["contract", "inventory", "plan"].flatMap((name) => [
			`--${name}`,
			join(root, `${name}.json`),
			`--${name}-sha256`,
			sha256(readFileSync(join(root, `${name}.json`))),
		]),
	];
	function run(extra: string[] = [], entry = checker, environment: NodeJS.ProcessEnv = {}) {
		const child = Bun.spawnSync([process.execPath, entry, ...args, ...extra], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 120_000,
			env: { ...process.env, ...environment },
		});
		const result = obj(decode(child.stdout.toString()));
		return { exit: child.exitCode, result, stderr: child.stderr.toString() };
	}
	return { root, put, args, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function collected(sources: Record<string, string> = fixtures, plan = defaultPlan) {
	const f = fixture(sources, plan);
	const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
	return { ...f, ...run };
}
test("exact collector observes an inventoried worker as a child execution context", () => {
	const f = fixture({
		"script/shared.ts": "export const shared = 1;\n",
		"script/worker.ts": 'import { shared } from "./shared"; export const ready = shared;\n',
		"script/subject.ts": 'import { shared } from "./shared"; import { Worker } from "node:worker_threads"; void shared; const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("exit", () => resolve()));\n',
		"script/subject.test.ts": 'import { test } from "bun:test"; import "./subject"; test("worker", () => {});\n',
	}, [{ id: "tests", kind: "test", paths: ["script/subject.test.ts"], args: [], expectedExitCode: 0 }]);
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		expect(run.exit).toBe(0);
		const processes = list(receipt.processes).map(obj);
		expect(processes).toHaveLength(2);
		const root = processes.find((process) => str(process.parent) === "");
		const worker = processes.find((process) => str(process.parent) !== "");
		if (!root || !worker) throw new FixtureError("missing worker receipt");
		expect(str(worker.parent)).toBe(str(root.id));
		expect(worker.pid).toBe(root.pid);
		expect(list(worker.loaded).map(str)).toContain("script/shared.ts");
		expect(list(root.loaded).map(str)).toContain("script/shared.ts");
	} finally { f.cleanup(); }
}, 120_000);
test("exact collector observes a Node worker with inherited preload identity", () => {
	const f = fixture({
		"script/shared.ts": "export const shared = 1;\n",
		"script/worker.ts": 'import { shared } from "./shared"; export const ready = shared;\n',
		"script/subject.ts": 'import { shared } from "./shared"; import { Worker } from "node:worker_threads"; void shared; const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("exit", () => resolve()));\n',
	}, cli("script/subject.ts", "node"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const processes = list(receipt.processes).map(obj);
		expect(processes).toHaveLength(2);
		const root = processes.find((process) => str(process.parent) === "");
		const worker = processes.find((process) => str(process.parent) !== "");
		if (!root || !worker) throw new FixtureError("missing Node worker receipt");
		expect(str(worker.parent)).toBe(str(root.id));
		expect(worker.runtime).toBe("node");
		expect(worker.pid).toBe(root.pid);
		expect(list(worker.loaded).map(str)).toContain("script/worker.ts");
	} finally { f.cleanup(); }
}, 120_000);
test("exact collector rejects a worker with an unapproved nonzero exit", () => {
	const f = fixture({
		"script/worker.ts": 'throw new Error("worker failure");\n',
		"script/subject.ts": 'import { Worker } from "node:worker_threads"; const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("error", () => resolve()));\n',
	}, cli("script/subject.ts", "node"));
	try {
		const run = f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("worker failure");
	} finally { f.cleanup(); }
}, 120_000);
function findings(result: { [key: string]: Json }): { [key: string]: Json }[] {
	return list(result.findings).map(obj);
}

test.each(["original", "changed-source", "changed-emit"] as const)("NamedError exact transfer preserves Schema independence or refuses changed identity: %s", (mode) => {
	const sourcePath = "packages/protocol/src/error/index.ts";
	const original = readFileSync(join(import.meta.dir, "..", sourcePath), "utf8");
	const source = mode === "changed-source" ? original.replace('this.name = "NamedError";', 'this.name = "ChangedErr";') : original;
	const f = fixture({
		[sourcePath]: source,
		"script/subject.ts": `import assert from "node:assert/strict";
import { z } from "zod";
import { NamedError } from "../packages/protocol/dist/error/index.js";
const schema = z.object({ message: z.string() });
const Example = NamedError.create("Example", schema);
assert.equal(Example.Schema.shape.data, schema);
assert.equal(new Example({ message: "ok" }).message, "ok");
const nativeDefine = Object.defineProperty;
const failure = new Error("stop before Schema");
Object.defineProperty = function (target, key, descriptor) {
  if (typeof target === "function" && key === "name") throw failure;
  return nativeDefine(target, key, descriptor);
};
try { assert.throws(() => NamedError.create("Rejected", schema), (error) => error === failure); }
finally { Object.defineProperty = nativeDefine; }
`,
	}, cli("script/subject.ts"));
	try {
		mkdirSync(join(f.root, "node_modules"), { recursive: true });
		symlinkSync(dirname(require.resolve("zod/package.json")), join(f.root, "node_modules/zod"));
		const project = "packages/protocol/tsconfig.json";
		f.put(project, JSON.stringify({
			compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", sourceMap: true, rootDir: "src", outDir: "dist", ...(mode === "changed-emit" ? { removeComments: true } : {}) },
			include: ["src"],
		}));
		const config = ts.getParsedCommandLineOfConfigFile(join(f.root, project), {}, {
			...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new FixtureError("invalid NamedError project"); },
		});
		if (!config) throw new FixtureError("missing NamedError project");
		const built = ts.createProgram(config.fileNames, config.options).emit();
		expect(built.emitSkipped).toBe(false);
		expect(built.diagnostics).toHaveLength(0);
		const contract = { version: 1, typescript: "5.9.2", roots: ["packages", "script"], projects: [project, "script/tsconfig.json"], topology: false };
		refreeze(f, "contract", contract);
		const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
		inventory.contractHash = sha256(JSON.stringify(contract));
		inventory.configurations = contract.projects.map((path) => ({ path, sha256: sha256(readFileSync(join(f.root, path))) }));
		refreeze(f, "inventory", inventory);
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		if (mode !== "original") {
			expect(run.exit).toBe(2);
			expect(run.result.complete).toBe(false);
			expect(str(obj(list(run.result.errors)[0]).message)).toContain("NamedError transfer identity differs");
			return;
		}
		expect(run.result.errors).toBeUndefined();
		expect(run.result.complete).toBe(true);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const root = list(receipt.processes).map(obj).find((row) => row.parent === "");
		const coverage = obj(obj(obj(root).coverage)[sourcePath]);
		const statements = obj(coverage.s);
		expect(Object.keys(statements)).toHaveLength(24);
		expect(Object.keys(obj(coverage.f))).toHaveLength(6);
		expect(Object.values(obj(coverage.b)).flatMap(list)).toHaveLength(14);
		expect(statements["4"]).toBe(3);
		expect(statements["5"]).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector permits only canonical git and kill utilities without process receipts", () => {
	const source = `import { spawnSync } from "node:child_process";
const git = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
const kill = spawnSync("/bin/kill", ["-0", String(process.pid)], { stdio: "ignore" });
if (git.exitCode !== 0 || kill.status !== 0) process.exit(7);
`;
	const f = fixture({ "script/utility.ts": source }, cli("script/utility.ts"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], checker, { PATH: "/usr/bin:/bin" });
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(run.result.complete).toBe(true);
		expect(list(obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8"))).processes)).toHaveLength(1);
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector permits canonical system shells and POSIX utilities without receipts", () => {
	const source = `import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sh = Bun.spawnSync(["/bin/sh", "-c", "printf ok"], { stdout: "pipe", stderr: "pipe" });
const bash = Bun.spawnSync(["/bin/bash", "-c", "exit 0"], { stdout: "pipe", stderr: "pipe" });
const fifo = spawnSync("mkfifo", [join(mkdtempSync(join(tmpdir(), "d945-fifo-")), "pipe")], { stdio: "ignore" });
const ps = Bun.spawnSync(["ps", "-p", String(process.pid), "-o", "stat="], { stdout: "pipe", stderr: "pipe" });
const tar = Bun.spawnSync(["tar", "--version"], { stdout: "pipe", stderr: "pipe" });
if (sh.stdout.toString() !== "ok" || bash.exitCode !== 0 || fifo.status !== 0 || ps.exitCode !== 0 || tar.exitCode !== 0) process.exit(7);
`;
	const f = fixture({ "script/utility.ts": source }, cli("script/utility.ts"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], checker, { PATH: "/usr/bin:/bin" });
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(run.result.complete).toBe(true);
		expect(list(obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8"))).processes)).toHaveLength(1);
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector runs an owned runtime entry outside the frozen root or an unfrozen inline program or a runtime probe natively, without credit or receipt", () => {
	const source = `import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const outside = mkdtempSync(join(tmpdir(), "d945-outside-"));
writeFileSync(join(outside, "copy.ts"), "process.exit(Number(process.argv[2]));\\n");
const external = Bun.spawnSync([process.execPath, "copy.ts", "0"], { cwd: outside, stdout: "pipe", stderr: "pipe" });
if (external.exitCode !== 0) process.exit(7);
writeFileSync(join(outside, "copy.test.ts"), 'import { test, expect } from "bun:test"; test("copy", () => expect(1).toBe(1));\\n');
const suite = Bun.spawnSync([process.execPath, "--smol", "test", "--timeout", "5000", "--reporter=junit", \`--reporter-outfile=\${join(outside, "tests.xml")}\`, "./copy.test.ts"], { cwd: outside, stdout: "pipe", stderr: "pipe" });
if (suite.exitCode !== 0 || !existsSync(join(outside, "tests.xml"))) process.exit(9);
const control = Bun.spawnSync([process.env.D945_PYTHON, "-I", "-c", "print(7)"], { cwd: outside, stdout: "pipe", stderr: "pipe" });
if (control.exitCode !== 0 || control.stdout.toString() !== "7\\n") process.exit(11);
if (Bun.spawnSync([process.env.D945_PYTHON, "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) process.exit(12);
if (process.argv[2] === "options" && Bun.spawnSync([process.execPath, "--smol", "script/utility.ts", "noop"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) process.exit(10);
if (process.argv[2] === "inside") {
	writeFileSync("script/unlisted.ts", "process.exit(0);\\n");
	if (Bun.spawnSync([process.execPath, "script/unlisted.ts"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) process.exit(8);
}
`;
	const f = fixture({ "script/utility.ts": source }, cli("script/utility.ts"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], checker, { PATH: "/usr/bin:/bin" });
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(run.result.complete).toBe(true);
		expect(list(obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8"))).processes)).toHaveLength(1);
	} finally { f.cleanup(); }
	const inside = fixture({ "script/utility.ts": source }, [{ id: "cli", kind: "cli", paths: ["script/utility.ts"], args: ["inside"], expectedExitCode: 0, runtime: "bun" }]);
	try {
		const run = inside.run(["--collect"], checker, { PATH: "/usr/bin:/bin" });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("entry/source is absent from frozen language inventory");
	} finally { inside.cleanup(); }
	const options = fixture({ "script/utility.ts": source }, [{ id: "cli", kind: "cli", paths: ["script/utility.ts"], args: ["options"], expectedExitCode: 0, runtime: "bun" }]);
	try {
		const run = options.run(["--collect"], checker, { PATH: "/usr/bin:/bin" });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("unregistered interpreter option --smol");
	} finally { options.cleanup(); }
}, 180_000);

test("exact collector rejects a utility executable planted inside the frozen root", () => {
	const f = fixture({ "script/utility.ts": 'Bun.spawnSync(["tar", "--version"]);\n' }, cli("script/utility.ts"));
	try {
		const fake = join(f.root, "fake-bin", "tar");
		mkdirSync(dirname(fake), { recursive: true });
		writeFileSync(fake, "#!/bin/sh\nexit 0\n");
		chmodSync(fake, 0o755);
		const run = f.run(["--collect"], checker, { PATH: `${dirname(fake)}:/usr/bin:/bin` });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("unregistered native executable");
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector permits bunx only when it is the pinned Bun binary", () => {
	const f = fixture({ "script/utility.ts": 'if (Bun.spawnSync(["bunx", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) process.exit(7);\n' }, cli("script/utility.ts"));
	try {
		const run = f.run(["--collect"], checker, { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` });
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		const fake = join(f.root, "fake-bin", "bunx");
		mkdirSync(dirname(fake), { recursive: true });
		writeFileSync(fake, "#!/bin/sh\nexit 0\n");
		chmodSync(fake, 0o755);
		const rejected = f.run(["--collect"], checker, { PATH: `${dirname(fake)}:/usr/bin:/bin` });
		expect(rejected.exit).toBe(2);
		expect(JSON.stringify(rejected.result)).toContain("unregistered native executable");
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector rejects a git executable planted inside the frozen root", () => {
	const f = fixture({ "script/utility.ts": 'Bun.spawnSync(["git", "--version"]);\n' }, cli("script/utility.ts"));
	try {
		const fake = join(f.root, "fake-bin", "git");
		mkdirSync(dirname(fake), { recursive: true });
		writeFileSync(fake, "#!/bin/sh\nexit 0\n");
		chmodSync(fake, 0o755);
		const run = f.run(["--collect"], checker, { PATH: `${dirname(fake)}:/usr/bin:/bin` });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("unregistered native executable");
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector does not turn a utility into a shell escape", () => {
	const f = fixture({ "script/utility.ts": 'Bun.spawn(["git", "--version"], { shell: true });\n' }, cli("script/utility.ts"));
	try {
		const run = f.run(["--collect"], checker, { PATH: "/usr/bin:/bin" });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("shell execution is not observable");
	} finally { f.cleanup(); }
}, 120_000);

test("real Bun false-positive DA cannot certify an unreachable original statement", async () => {
	const source = `export function choose(mode: number, count: { value: number }): string {
  switch (mode) {
    case 1:
      count.value += 1;
      return "one";
    case 2:
      count.value += 10;
      return "two";
    default:
      count.value += 100;
      return "other";
  }
}

export function branch(enabled: boolean, count: { value: number }): number {
  if (enabled) {
    count.value += 1000;
    return 1;
  }
  count.value += 10000;
  return 2;
}

export function dormant(count: { value: number }): void {
  count.value += 100000;
}

export function implicitReturn(enabled: boolean, count: { value: number }): void {
  if (enabled) return;
  count.value += 1000000;
}
export function sameLine(enabled: boolean) { if (enabled) return 3; return 4; }
export function multiline() {
  const value = (
    40 +
    2
  );
  return value;
}
`;
	const f = fixture({
		"script/subject.ts": source,
		"script/subject.test.ts": 'import { test, expect } from "bun:test"; import { choose, branch, implicitReturn, sameLine, multiline } from "./subject"; test("successful taken branch", () => { const count = { value: 0 }; expect(choose(1, count)).toBe("one"); expect(branch(true, count)).toBe(1); implicitReturn(true, count); expect(count.value).toBe(1001); expect(sameLine(true)).toBe(3); expect(multiline()).toBe(42); });\n',
	});
	try {
		const native = Bun.spawnSync([process.execPath, "test", "./script/subject.test.ts", "--coverage", "--coverage-reporter=lcov", "--coverage-dir=native"], { cwd: f.root, timeout: 30_000 });
		expect(native.exitCode).toBe(0);
		expect(native.stderr.toString()).toContain("1 pass");
		const lcov = parseNativeLcov(readFileSync(join(f.root, "native/lcov.info"), "utf8"), "script");
		const lines = new Map(lcov.find((file) => file.path.endsWith("subject.ts"))?.lines.map((row) => [row.line, row.hits]));
		expect(lines.get(21)).toBeGreaterThan(0);
		expect(lines.get(25)).toBeGreaterThan(0);
		const collected = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(collected.exit).toBe(1);
		expect(collected.result.complete).toBe(true);
		const inventory = loadInventory(f.root, join(f.root, "inventory.json"));
		const prepared = inventory.files.map(prepare);
		const file = prepared.find((file) => file.path === "script/subject.ts");
		if (!file) throw new Error("missing subject map");
		const exact = loadCoverage(join(f.root, "coverage.json"), inventory, prepared, { root: f.root, contract: join(f.root, "contract.json"), inventory: join(f.root, "inventory.json"), plan: join(f.root, "plan.json") });
		const counts = exact.totals.get(file.path);
		if (!counts) throw new Error("missing exact counters");
		const at = (text: string) => {
			const offset = source.indexOf(text);
			const prefix = source.slice(0, offset).split("\n");
			const entries = Object.entries(file.statementMap).filter(([, range]) => range.start.line === prefix.length && range.start.column === (prefix.at(-1)?.length ?? 0));
			expect(entries, text).toHaveLength(1);
			return entries[0]?.[0] ?? "";
		};
		for (const text of ['count.value += 1;', 'count.value += 1000;', 'return 1;', 'return 3;', '40 +', 'return value;']) expect(counts.s[at(text)]).toBe(1);
		for (const text of ['return 2;', 'count.value += 100000;', 'return 4;']) expect(counts.s[at(text)]).toBe(0);
		expect(Object.entries(file.fnMap).filter(([, fn]) => fn.name === "dormant").map(([id]) => counts.f[id])).toEqual([0]);
		expect(readFileSync(join(f.root, "script/subject.ts"), "utf8")).toBe(source);
		console.info(JSON.stringify({ nativeDA21: lines.get(21), nativeDA25: lines.get(25), exactReturn2: counts.s[at("return 2;")], exactDormant: counts.s[at("count.value += 100000;")] }));
		// The old boundary credited this never-executed return from DA:21,1.
		expect(statementCounters(file, exact).s[at("return 2;")]).toBe(0);
		expect(statementCounters(file, exact)).toEqual(counts);
		expect(() => statementCounters(file)).toThrow("missing exact statement evidence");
		const document = await measureStatic({ root: f.root, inventory: join(f.root, "inventory.json") });
		const joined = joinBounds(document, { identity: inventory, coverage: exact, selectedLanes: ["script"] });
		const branch = joined.records.find((row) => row.name === "branch");
		expect(branch?.coverage.hit).toBeLessThan(branch?.coverage.total ?? 1);
		expect(branch?.crap).toBeGreaterThan(branch?.cyclomatic ?? 0);
		const uncovered = joined.measurement.findings.filter((row) => row.gate === "coverage" && row.path === file.path);
		expect(uncovered.some((row) => row.line === 21)).toBe(true);
		expect(uncovered.some((row) => row.line === 25)).toBe(true);
		expect(uncovered.some((row) => row.line === 17)).toBe(false);
		console.info(JSON.stringify({ exactRatchetRows: uncovered, branch }));
	} finally { f.cleanup(); }
}, 120_000);

function emittedWorkspace(
	valueSource = "export const value = 42;\n",
	testSource = 'import { test, expect } from "bun:test"; import { choose } from "@fixture/emitted"; test("emitted entry", () => { expect(choose(true)).toBe(42); });\n',
) {
	const source = `import { value } from "./value.js";
export function choose(taken: boolean) {
  if (taken) return value;
  return 99;
}
export function dormant() {
  return 100;
}
`;
	const f = fixture({
		"script/pkg/src/index.ts": source,
		"script/pkg/src/value.ts": valueSource,
		"script/subject.test.ts": testSource,
	});
	f.put("script/pkg/package.json", '{"name":"@fixture/emitted","type":"module","exports":"./dist/index.js"}');
	f.put("tsconfig.base.json", '{"compilerOptions":{"strict":true,"target":"ES2020","module":"ESNext"}}');
	f.put("script/tsconfig.json", '{"extends":"../tsconfig.base.json","compilerOptions":{"sourceMap":true,"rootDir":"pkg/src","outDir":"pkg/dist"},"include":["pkg/src"]}');
	const config = join(f.root, "script/tsconfig.json");
	const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error("fixture config"); } });
	if (!parsed) throw new Error("fixture config absent");
	const emitted = ts.createProgram(parsed.fileNames, parsed.options).emit();
	expect(emitted.emitSkipped).toBe(false);
	expect(emitted.diagnostics).toHaveLength(0);
	mkdirSync(join(f.root, "node_modules/@fixture"), { recursive: true });
	symlinkSync(join(f.root, "script/pkg"), join(f.root, "node_modules/@fixture/emitted"));
	const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
	inventory.configurations = ["script/tsconfig.json", "tsconfig.base.json"].map((path) => ({ path, sha256: sha256(readFileSync(join(f.root, path))) }));
	f.put("inventory.json", JSON.stringify(inventory));
	for (const name of ["inventory", "contract"]) f.args[f.args.indexOf(`--${name}-sha256`) + 1] = sha256(readFileSync(join(f.root, `${name}.json`)));
	return { ...f, source };
}

test("verified workspace emit preserves package resolution and exact original counters", () => {
	const f = emittedWorkspace();
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.result.errors).toBeUndefined();
		expect(run.exit).toBe(1);
		expect(run.result.complete).toBe(true);
		const inventory = loadInventory(f.root, join(f.root, "inventory.json"));
		const prepared = inventory.files.map(prepare);
		const exact = loadCoverage(join(f.root, "coverage.json"), inventory, prepared, { root: f.root, contract: join(f.root, "contract.json"), inventory: join(f.root, "inventory.json"), plan: join(f.root, "plan.json") });
		const file = prepared.find((file) => file.path === "script/pkg/src/index.ts");
		if (!file) throw new Error("missing original map");
		const counts = statementCounters(file, exact);
		const hits = (line: number) => Object.entries(file.statementMap).filter(([, range]) => range.start.line === line).map(([id]) => counts.s[id]);
		expect(hits(3)).toEqual([1, 1]);
		expect(hits(4)).toEqual([0]);
		expect(hits(7)).toEqual([0]);
		expect(Object.entries(file.fnMap).filter(([, fn]) => fn.name === "dormant").map(([id]) => counts.f[id])).toEqual([0]);
		expect([...exact.totals.keys()].some((path) => path.includes("/dist/"))).toBe(false);
	} finally { f.cleanup(); }
}, 120_000);

for (const defect of ["stale-source", "stale-build", "javascript", "map", "escaping-map", "map-file", "map-source", "configuration", "unmapped-generated"]) {
	test(`workspace emit rejects ${defect} without generated ownership`, () => {
		const f = emittedWorkspace();
		try {
			const js = "script/pkg/dist/index.js", mapPath = `${js}.map`, sourcePath = "script/pkg/src/index.ts";
			if (defect === "stale-source" || defect === "stale-build") {
				const source = f.source.replace("return 99", "return 98");
				f.put(sourcePath, source);
				if (defect === "stale-build") {
					const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
					const entry = list(inventory.files).map(obj).find((entry) => entry.path === sourcePath);
					if (!entry) throw new Error("missing source");
					entry.sha256 = sha256(source);
					f.put("inventory.json", JSON.stringify(inventory));
					f.args[f.args.indexOf("--inventory-sha256") + 1] = sha256(readFileSync(join(f.root, "inventory.json")));
				}
			} else if (defect === "javascript") f.put(js, readFileSync(join(f.root, js), "utf8").replace("return 99", "return 98"));
			else if (defect === "configuration") f.put("tsconfig.base.json", '{"compilerOptions":{"target":"ESNext","module":"ESNext"}}');
			else if (defect === "unmapped-generated") rmSync(join(f.root, mapPath));
			else {
				const map = obj(decode(readFileSync(join(f.root, mapPath), "utf8")));
				if (defect === "map") map.mappings = "AAAA";
				if (defect === "escaping-map") map.sources = ["../../../../outside.ts"];
				if (defect === "map-file") map.file = "different.js";
				if (defect === "map-source") map.sources = ["../src/value.ts"];
				f.put(mapPath, JSON.stringify(map));
			}
			const run = f.run(["--collect"]);
			expect(run.exit).toBe(2);
			expect(run.result.complete).toBe(false);
			expect(list(run.result.errors)).toHaveLength(1);
		} finally { f.cleanup(); }
	}, 120_000);
}

test("workspace emit cannot silently ignore declared project references", () => {
	const f = emittedWorkspace();
	try {
		const configPath = "script/tsconfig.json";
		const config = obj(decode(readFileSync(join(f.root, configPath), "utf8")));
		config.references = [{ path: "./referenced-project" }];
		f.put(configPath, JSON.stringify(config));
		const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
		const configuration = list(inventory.configurations).map(obj).find((entry) => entry.path === configPath);
		if (!configuration) throw new Error("missing configuration");
		configuration.sha256 = sha256(readFileSync(join(f.root, configPath)));
		f.put("inventory.json", JSON.stringify(inventory));
		f.args[f.args.indexOf("--inventory-sha256") + 1] = sha256(readFileSync(join(f.root, "inventory.json")));
		const run = f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain("emitted_config");
	} finally { f.cleanup(); }
}, 120_000);

test("workspace emit rejects bytes that only decode to the compiler output", () => {
	const replacement = String.fromCodePoint(0xfffd);
	const f = emittedWorkspace(`export const value = 42; // ${replacement}\n`);
	try {
		const path = join(f.root, "script/pkg/dist/value.js");
		const bytes = readFileSync(path);
		const offset = bytes.indexOf(Buffer.from(replacement));
		expect(offset).toBeGreaterThanOrEqual(0);
		const corrupted = Buffer.concat([bytes.subarray(0, offset), Buffer.from([255]), bytes.subarray(offset + 3)]);
		expect(corrupted.toString("utf8")).toBe(bytes.toString("utf8"));
		writeFileSync(path, corrupted);
		const run = f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain("tamper");
	} finally { f.cleanup(); }
}, 120_000);

for (const [name, source] of [
	["const enum", "const enum Answer { Value = 42 }\nexport const value = Answer.Value;\n"],
	["downlevel class fields", "class Answer { value = 42; }\nexport const value = new Answer().value;\n"],
]) test(`workspace emit fails closed for unsupported ${name} maps`, () => {
	if (!source) throw new Error("missing lowering fixture");
	const f = emittedWorkspace(source);
	try {
		const native = Bun.spawnSync([process.execPath, "test", "./script/subject.test.ts"], { cwd: f.root, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		expect(native.exitCode).toBe(0);
		const run = f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain("source_map");
	} finally { f.cleanup(); }
}, 120_000);

test("write-result stores the complete verdict and prints a hashed pointer", () => {
	const f = fixture();
	try {
		const coverage = join(f.root, "coverage.json"), verdict = join(f.root, "result.json");
		const run = f.run(["--collect", "--write-coverage", coverage, "--write-result", verdict]);
		const stored = obj(decode(readFileSync(verdict, "utf8")));
		expect(stored.exitCode).toBe(run.exit);
		expect(Object.keys(run.result).sort()).toEqual(["aggregate", "complete", "exitCode", "result", "resultSha256"]);
		expect(run.result.result).toBe(verdict);
		expect(run.result.resultSha256).toBe(sha256(readFileSync(verdict)));
		expect(run.result.complete).toBe(true);
		expect(run.result.aggregate).toEqual(stored.aggregate);
		expect(list(stored.measurements).length).toBeGreaterThan(0);
		expect(f.run(["--collect", "--write-coverage", join(f.root, "again.json"), "--write-result", verdict]).exit).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("workspace emit receipt binds compiler, artifact, original and map identities", () => {
	const f = emittedWorkspace();
	try {
		const path = join(f.root, "coverage.json");
		expect(f.run(["--collect", "--write-coverage", path]).exit).toBe(1);
		const original = obj(decode(readFileSync(path, "utf8")));
		for (const field of ["source", "project", "sha256", "mapSha256", "mapHash", "observationSha256", "observationCount", "syntheticCount"]) {
			const receipt = structuredClone(original);
			const process = list(receipt.processes).map(obj).find((process) => process.emitted !== undefined);
			if (!process) throw new Error("missing emitted provenance");
			const proof = obj(list(process.emitted)[0]);
			proof[field] = field.endsWith("256") || field === "mapHash" ? "0".repeat(64) : "script/wrong.ts";
			f.put("coverage.json", JSON.stringify(receipt));
			const verified = f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))]);
			expect(verified.exit).toBe(2);
			expect(obj(list(verified.result.errors)[0]).code).toBe("identity");
		}
		f.put("coverage.json", JSON.stringify(original));
		f.put("script/pkg/dist/value.js", readFileSync(join(f.root, "script/pkg/dist/value.js"), "utf8").replace("42", "43"));
		expect(f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))]).exit).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("a single uncovered statement cannot become exact full coverage by rounding", () => {
	expect(exactMetric(100_000, 99_999)).toEqual({
		covered: 99_999,
		total: 100_000,
		notApplicable: false,
	});
	for (const n of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
		expect(() => exactMetric(n, 0)).toThrow();
	expect(() => exactMetric(1, 2)).toThrow();
});

test("strict input decoding rejects ambiguous payloads without interpreting fixture strings", () => {
	for (const input of ['{"a":1,"a":2}', "1 trailing", "[1,]", "{a:1}", "1e400", '"\\x"'])
		expect(() => decode(input)).toThrow();
	expect(decode('{"__proto__":1,"value":"unknown any istanbul ignore next"}')).toEqual({
		["__proto__"]: 1,
		value: "unknown any istanbul ignore next",
	});
});

test("real Bun tests fully cover every dimension, including test callbacks, and old owner consumes the receipt", () => {
	const f = collected();
	try {
		expect(f.exit).toBe(0);
		const metrics = obj(f.result.aggregate);
		for (const metric of Object.values(metrics)) {
			const m = obj(metric);
			expect(m.covered).toBe(m.total);
		}
		expect(list(f.result.measurements).some((m) => obj(m).category === "test")).toBe(true);
		const path = join(f.root, "coverage.json");
		const verified = f.run(
			["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))],
			owner,
		);
		expect(verified.exit).toBe(0);
		expect(verified.result.aggregate).toEqual(f.result.aggregate);
	} finally {
		f.cleanup();
	}
}, 120_000);

test("actual uncovered statement, branch, function and line remain separate findings", () => {
	const f = collected({
		...fixtures,
		"script/subject.ts": `${fixtures["script/subject.ts"]}export function neverCalled() { return 7; }\n`,
		"script/subject.test.ts": fixtures["script/subject.test.ts"].replace(
			"expect(select(false)).toBe(0);",
			"",
		),
	});
	try {
		expect(f.exit).toBe(1);
		expect(new Set(findings(f.result).map((v) => v.class))).toEqual(
			new Set(["statements", "branches", "functions", "lines"]),
		);
	} finally {
		f.cleanup();
	}
}, 120_000);

test("unimported nested tooling receives regenerated zero counters, never an empty-report exemption", () => {
	const f = collected({
		...fixtures,
		"script/nested/unimported.ts": "export const unseen = () => 7;\n",
	});
	try {
		expect(f.exit).toBe(1);
		expect(
			findings(f.result).some(
				(v) => v.path === "script/nested/unimported.ts" && v.class === "functions",
			),
		).toBe(true);
	} finally {
		f.cleanup();
	}
}, 120_000);

test("TSX executable maps retain original identity under the automatic JSX runtime", () => {
	// Like packages/ui, the view imports no React binding: JSX resolves through
	// react/jsx-runtime, which the fixture supplies outside the inventory.
	const f = fixture({
		...fixtures,
		"script/subject.ts":
			'import { view } from "./view"; export function select(value: boolean) { view(); if(value) return 1; return 0; }',
		"script/view.tsx": "export function view(){ return <div>{1}</div>; }",
	});
	try {
		mkdirSync(join(f.root, "node_modules/react"), { recursive: true });
		writeFileSync(join(f.root, "node_modules/react/package.json"), '{"name":"react","exports":{"./jsx-runtime":"./jsx-runtime.js"}}');
		writeFileSync(join(f.root, "node_modules/react/jsx-runtime.js"), "export function jsx(tag, props) { return { tag, props }; }\nexport const jsxs = jsx;\n");
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		if (run.exit !== 0) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(list(run.result.measurements).some((m) => obj(m).path === "script/view.tsx")).toBe(true);
	} finally {
		f.cleanup();
	}
}, 120_000);

test("Bun synchronous and asynchronous child receipts supply genuine coverage", () => {
	const sources = {
		"script/child.ts": "console.log(41 + 1);\n",
		"script/parent.ts":
			'const sync = Bun.spawnSync([process.execPath, "script/child.ts"], {stdout:"pipe"}); console.log(sync.stdout.toString()); const asyncChild = Bun.spawn([process.execPath, "script/child.ts"], {stdout:"ignore"}); await asyncChild.exited;\n',
	};
	const f = collected(sources, [
		{ id: "parent", kind: "cli", paths: ["script/parent.ts"], args: [], expectedExitCode: 0 },
	]);
	try {
		expect(f.exit).toBe(0);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		expect(list(receipt.processes)).toHaveLength(3);
	} finally {
		f.cleanup();
	}
}, 120_000);

test("missing input, stale source, altered inventory, incomplete inventory and unsupported syntax fail closed", () => {
	const absent = Bun.spawnSync([process.execPath, checker], { stdout: "pipe" });
	expect(absent.exitCode).toBe(2);
	expect(obj(list(obj(decode(absent.stdout.toString())).errors)[0]).code).toBe("missing_input");
	for (const defect of [
		"source",
		"inventory",
		"project",
		"syntax",
		"directive",
		"node",
	]) {
		const source =
			defect === "syntax"
				? "export const broken = ;"
				: defect === "directive"
					? "/* istanbul ignore next */ export function x(){return 1;}"
					: defect === "node"
						? 'import {spawn} from "node:child_process"; spawn("node",[]);'
						: fixtures["script/subject.ts"];
		const f = fixture({
			...fixtures,
			"script/subject.ts": source,

		});
		try {
			if (defect === "source") f.put("script/subject.ts", `${source}\n// drift`);
			if (defect === "inventory") f.put("inventory.json", "{}");
			if (defect === "project") {
				const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
				inventory.configurations = [];
				f.put("inventory.json", JSON.stringify(inventory));
				f.args[f.args.indexOf("--inventory-sha256") + 1] = sha256(
					readFileSync(join(f.root, "inventory.json")),
				);
			}
			const result = f.run(["--collect"]);
			expect(result.exit).toBe(2);
			expect(result.result.complete).toBe(false);
		} finally {
			f.cleanup();
		}
	}
}, 120_000);

function tamperReceipt(receipt: { [key: string]: Json }, defect: string): void {
	const processes = list(receipt.processes);
	const process = obj(processes[0]);
	const coverage = obj(process.coverage);
	const path = Object.keys(coverage)[0] ?? "";
	const file = obj(coverage[path]);
	if (defect === "maps") receipt.maps = list(receipt.maps).slice(1);
	if (defect === "map-identity") file.path = "script/other.ts";
	if (defect === "missing-file") delete coverage[path];
	if (defect === "process") receipt.processes = [];
	if (["counter", "fraction", "overflow", "negative"].includes(defect)) {
		const s = obj(file.s);
		const id = Object.keys(s)[0] ?? "0";
		if (defect === "counter") delete s[id];
		else
			s[id] =
				defect === "fraction" ? 0.5 : defect === "negative" ? -1 : Number.MAX_SAFE_INTEGER + 1;
	}
}

test("real receipts reject tampered maps, missing counters/files/processes and noninteger counts", () => {
	const f = collected();
	try {
		expect(f.exit).toBe(0);
		const original = readFileSync(join(f.root, "coverage.json"), "utf8");
		for (const defect of [
			"maps",
			"map-identity",
			"missing-file",
			"counter",
			"fraction",
			"overflow",
			"negative",
			"process",
		]) {
			const receipt = obj(decode(original));
			tamperReceipt(receipt, defect);
			f.put("bad.json", JSON.stringify(receipt));
			const result = f.run([
				"--coverage-input",
				join(f.root, "bad.json"),
				"--coverage-sha256",
				sha256(readFileSync(join(f.root, "bad.json"))),
			]);
			expect(result.exit).toBe(2);
		}
	} finally {
		f.cleanup();
	}
}, 120_000);

test("lost real child receipt cannot be credited as covered", () => {
	const f = collected(
		{
			"script/child.ts": "console.log(1);",
			"script/parent.ts": 'Bun.spawnSync([process.execPath,"script/child.ts"]);',
		},
		[{ id: "parent", kind: "cli", paths: ["script/parent.ts"], args: [], expectedExitCode: 0 }],
	);
	try {
		expect(f.exit).toBe(0);
		const r = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		r.processes = list(r.processes).filter((p) => obj(p).parent === "");
		f.put("lost.json", JSON.stringify(r));
		const result = f.run([
			"--coverage-input",
			join(f.root, "lost.json"),
			"--coverage-sha256",
			sha256(readFileSync(join(f.root, "lost.json"))),
		]);
		expect(result.exit).toBe(2);
		expect(str(obj(list(result.result.errors)[0]).code)).toBe("incomplete_coverage");
	} finally {
		f.cleanup();
	}
}, 120_000);

test("real 99 of 100 statements fails without percentage rounding", () => {
	const f = collected(
		{
			"script/hundred.ts": `let n = 0;\n${"n++;\n".repeat(98)}export function missing() { return n; }\n`,
		},
		[{ id: "hundred", kind: "cli", paths: ["script/hundred.ts"], args: [], expectedExitCode: 0 }],
	);
	try {
		expect(f.exit).toBe(1);
		expect(obj(obj(f.result.aggregate).statements)).toEqual({
			total: 100,
			covered: 99,
			notApplicable: false,
		});
	} finally {
		f.cleanup();
	}
}, 120_000);

test("caught unsupported subprocess cannot become clean coverage", () => {
	const f = fixture(
		{
			"script/child.ts": 'try { Bun.spawnSync([new URL("../fake-bin/tool", import.meta.url).pathname]); } catch {}',
			"script/parent.ts": 'Bun.spawnSync([process.execPath,"script/child.ts"]);',
		},
		[{ id: "parent", kind: "cli", paths: ["script/parent.ts"], args: [], expectedExitCode: 0 }],
	);
	try {
		mkdirSync(join(f.root, "fake-bin"));
		writeFileSync(join(f.root, "fake-bin/tool"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(f.root, "fake-bin/tool"), 0o755);
		const run = f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(JSON.stringify(run.result)).toContain("unregistered native executable");
	} finally {
		f.cleanup();
	}
}, 120_000);

test("type-only declarations are syntax-proven not-applicable, not missing-file credit", () => {
	const f = collected({
		...fixtures,
		"script/types.d.ts": "export interface Example { readonly value: string; }",
	});
	try {
		expect(f.exit).toBe(0);
		const declaration = list(f.result.measurements)
			.map(obj)
			.find((m) => m.path === "script/types.d.ts");
		expect(obj(obj(declaration).metrics).functions).toEqual({
			total: 0,
			covered: 0,
			notApplicable: true,
		});
	} finally {
		f.cleanup();
	}
}, 120_000);

function refreeze(f: ReturnType<typeof fixture>, name: string, value: Json): void {
	f.put(`${name}.json`, JSON.stringify(value));
	f.args[f.args.indexOf(`--${name}-sha256`) + 1] = sha256(readFileSync(join(f.root, `${name}.json`)));
}
function cli(path: string, runtime = "bun"): Command[] {
	return [{ id: "cli", kind: "cli", paths: [path], args: [], expectedExitCode: 0, runtime }];
}
function verifyChanged(f: ReturnType<typeof fixture>, receipt: Json) {
	f.put("changed.json", JSON.stringify(receipt));
	return f.run(["--coverage-input", join(f.root, "changed.json"), "--coverage-sha256", sha256(readFileSync(join(f.root, "changed.json")))]);
}

function collectReceipt(f: ReturnType<typeof fixture>): { [key: string]: Json } {
	const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
	expect(run.exit).toBe(0);
	return obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
}

function pythonProcess(receipt: { [key: string]: Json }): { [key: string]: Json } {
	return obj(list(receipt.processes).map(obj).find((p) => p.runtime === "python"));
}

test("native Node entry and Bun-to-Node processes preserve effects and original TS counters", () => {
	const f = collected({
		"script/child.ts": 'import {appendFileSync} from "node:fs"; appendFileSync("effect.txt","N"); console.log(42);',
		"script/parent.ts": 'import {spawnSync,spawn} from "node:child_process"; import assert from "node:assert/strict"; const sync=spawnSync("node",["script/child.ts"],{encoding:"utf8"}); assert.equal(sync.status,0); assert.equal(sync.stdout.trim(),"42"); const child=spawn("node",["script/child.ts"]); await new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{assert.equal(code,0);assert.equal(signal,null);resolve();});});',
	}, cli("script/parent.ts"));
	try {
		expect(f.exit).toBe(0);
		expect(readFileSync(join(f.root, "effect.txt"), "utf8")).toBe("NN");
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		expect(list(receipt.processes).filter((r) => obj(r).runtime === "node")).toHaveLength(2);
	} finally { f.cleanup(); }
	const direct = collected({ "script/main.ts": "const value: number=42; console.log(value);" }, cli("script/main.ts", "node"));
	try { expect(direct.exit).toBe(0); } finally { direct.cleanup(); }
}, 120_000);

test("Python statements, functions, static arcs, short circuits and lines are real independent counters", () => {
	const source = 'def select(value):\n    if value:\n        return 1\n    return 0\nassert select(True) == 1\nassert select(False) == 0\ndef choose(value):\n    return value and 7\nx = choose(True)\ny = choose(False)\nassert x == 7\nassert y is False\nopen("effect.txt", "w").write("PY")\n';
	const f = collected({ "script/main.py": source }, cli("script/main.py", "python"));
	try {
		expect(f.exit).toBe(0);
		expect(readFileSync(join(f.root, "effect.txt"), "utf8")).toBe("PY");
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const process = obj(list(receipt.processes)[0]);
		expect(process.runtime).toBe("python");
		expect(Object.keys(obj(process.lines))).toEqual(["script/main.py"]);
		for (const defect of ["line", "map", "process"]) {
			const changed = obj(decode(JSON.stringify(receipt)));
			if (defect === "map") changed.maps = [];
			if (defect === "process") changed.processes = [];
			if (defect === "line") obj(list(changed.processes)[0]).lines = {};
			expect(verifyChanged(f, changed).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test("the Python collector map joins the metrics analyzer map for methods, nested defs and lambdas", async () => {
	const source = 'class Box:\n    def __init__(self, value):\n        self.value = value\n\n    def scale(self, factor):\n        def inner(v):\n            return v * factor\n        return inner(self.value)\n\n\ndouble = lambda v: v * 2\nassert Box(3).scale(2) == 6\nassert double(4) == 8\n';
	const f = collected({ "script/main.py": source }, cli("script/main.py", "python"));
	try {
		expect(f.exit).toBe(0);
		const inventory = loadInventory(f.root, join(f.root, "inventory.json"));
		const document = await measureStatic({ root: f.root, inventory: join(f.root, "inventory.json") });
		const prepared = document.measured.map((row) => row.analysis.prepared);
		const file = prepared.find((row) => row.path === "script/main.py");
		if (!file) throw new Error("missing Python map");
		expect(Object.values(file.fnMap).map((fn) => fn.name).sort()).toEqual(["<lambda>", "__init__", "inner", "scale"]);
		const exact = loadCoverage(join(f.root, "coverage.json"), inventory, prepared, { root: f.root, contract: join(f.root, "contract.json"), inventory: join(f.root, "inventory.json"), plan: join(f.root, "plan.json") });
		const counts = exact.totals.get("script/main.py");
		if (!counts) throw new Error("missing exact counters");
		expect(Object.values(counts.f)).toEqual([1, 1, 1, 1]);
		const joined = joinBounds(document, { identity: inventory, coverage: exact, selectedLanes: ["script"] });
		expect(joined.measurement.findings.filter((row) => row.gate === "coverage" && row.path === "script/main.py")).toEqual([]);
	} finally { f.cleanup(); }
}, 120_000);

test("unexecuted Python is uncovered, not unsupported and not credited by a host string", () => {
	const f = collected({ "script/main.ts": "console.log(42);", "script/unloaded.py": "def missing():\n    return 1\n" }, cli("script/main.ts"));
	try { expect(f.exit).toBe(1); expect(findings(f.result).some((v) => v.path === "script/unloaded.py" && v.class === "functions")).toBe(true); }
	finally { f.cleanup(); }
}, 120_000);

test.each([
	["refusing", 'console.error("refused"); process.exit(1);', 1, null],
	["killed", 'process.kill(process.pid,"SIGKILL");', null, "SIGKILL"],
])("a %s child's flushed receipt is complete evidence; a missing child receipt is not", (_, body, exitCode, signal) => {
	const f = collected({ "script/main.ts": 'Bun.spawnSync([process.execPath,"script/child.ts"]);', "script/child.ts": body }, cli("script/main.ts"));
	try {
		expect(f.exit).toBe(0);
		const original = readFileSync(join(f.root, "coverage.json"), "utf8");
		const receipt = obj(decode(original));
		const processes = list(receipt.processes).map(obj);
		const child = obj(processes.find((p) => p.parent !== ""));
		expect(child.exitCode).toBe(exitCode);
		expect(child.signal).toBe(signal);
		expect(Object.values(obj(obj(obj(child.coverage)["script/child.ts"]).s))).toEqual(body.split(";").filter(Boolean).map(() => 1));
		expect(verifyChanged(f, receipt).exit).toBe(0);
		const partial = obj(decode(original));
		partial.processes = list(partial.processes).filter((p) => obj(p).parent === "");
		expect(verifyChanged(f, partial).exit).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("nonowned ESM and CommonJS dependencies execute natively without coverage credit", () => {
	const f = fixture({ "script/main.ts": 'import assert from "node:assert/strict"; import {value} from "review-dependency"; import common from "review-common"; assert.equal(value + common,42);' }, cli("script/main.ts"));
	try {
		f.put("node_modules/review-dependency/package.json", '{"type":"module","exports":"./index.js"}');
		f.put("node_modules/review-dependency/index.js", 'export const value=20;');
		f.put("node_modules/review-common/package.json", '{"main":"index.cjs"}');
		f.put("node_modules/review-common/index.cjs", 'module.exports=22;');
		const native = Bun.spawnSync([process.execPath, "script/main.ts"], { cwd: f.root });
		expect(native.exitCode).toBe(0);
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		expect(obj(list(receipt.processes)[0]).loaded).toEqual(["script/main.ts"]);
	} finally { f.cleanup(); }
}, 120_000);

test("missing owned imports still fail at the loader boundary", () => {
	const f = fixture({ "script/main.ts": 'import {writeFileSync} from "node:fs"; writeFileSync("script/late.ts","export const value=42;"); await import("./late.ts");' }, cli("script/main.ts"));
	try { expect(f.run(["--collect"]).exit).toBe(2); }
	finally { f.cleanup(); }
}, 120_000);

test("Bun child preloads retain native import order and instrument the child context", () => {
	const f = fixture({
		"script/main.ts": 'import assert from "node:assert/strict"; const child=Bun.spawnSync([process.execPath,"--preload","./script/preload.ts","./script/child.ts"],{stdout:"pipe"}); assert.equal(child.exitCode,0); assert.equal(child.stdout.toString(),"IMPORT\\nPRELOAD\\nCHILD\\n");',
		"script/preload.ts": 'import "./imported"; console.log("PRELOAD");',
		"script/imported.ts": 'console.log("IMPORT");',
		"script/child.ts": 'console.log("CHILD");',
	}, cli("script/main.ts"));
	try {
		expect(Bun.spawnSync([process.execPath, "script/main.ts"], { cwd: f.root }).exitCode).toBe(0);
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const child = list(receipt.processes).map(obj).find((p) => p.parent !== "");
		expect(list(obj(child).loaded).sort()).toEqual(["script/child.ts", "script/imported.ts", "script/preload.ts"]);
		expect(obj(child).entry).toBe("script/child.ts");
	} finally { f.cleanup(); }
}, 120_000);

test("Python abrupt zero exit cannot substitute persistent counters for normal flush", () => {
	const f = collected({ "script/main.py": "import os\nos._exit(0)\n" }, cli("script/main.py", "python"));
	try { expect(f.exit).toBe(2); expect(f.result.complete).toBe(false); }
	finally { f.cleanup(); }
}, 120_000);

test("normal Python flush provenance survives collection and rejects receipt corruption", () => {
	const f = collected({ "script/main.py": "print(42)\n" }, cli("script/main.py", "python"));
	try {
		expect(f.exit).toBe(0);
		const original = readFileSync(join(f.root, "coverage.json"), "utf8");
		const receipt = obj(decode(original));
		expect(obj(obj(list(receipt.processes)[0]).trace).flushed).toBe(true);
		for (const defect of ["missing", "identity", "version", "flushed", "files", "arc"]) {
			const changed = obj(decode(original));
			const process = obj(list(changed.processes)[0]);
			const trace = obj(process.trace);
			if (defect === "missing") process.trace = null;
			if (defect === "identity") trace.id = "other-process";
			if (defect === "version") trace.python = "3.13.0";
			if (defect === "flushed") trace.flushed = false;
			if (defect === "files") trace.files = {};
			if (defect === "arc") obj(obj(trace.files)["script/main.py"]).arcs = [[1, 0.5]];
			expect(verifyChanged(f, changed).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test.each(["empty-arcs", "empty-translated", "both-empty", "impossible", "entry-removed", "added-impossible", "line-counter"])("real Python trace rejects semantic mutation %s after outer rehash", (defect) => {
	const f = collected({ "script/main.py": "print(42)\n" }, cli("script/main.py", "python"));
	try {
		expect(f.exit).toBe(0);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const process = obj(list(receipt.processes)[0]);
		const row = obj(obj(obj(process.trace).files)["script/main.py"]);
		expect(row.arcs).toEqual([[-1, 1], [1, -1]]);
		if (defect === "empty-arcs" || defect === "both-empty") row.arcs = [];
		if (defect === "empty-translated" || defect === "both-empty") row.translatedArcs = [];
		if (defect === "impossible") { row.arcs = [[1, 1]]; row.translatedArcs = [[1, 1]]; }
		if (defect === "entry-removed") { row.arcs = [[1, -1]]; row.translatedArcs = [[1, -1]]; }
		if (defect === "added-impossible") { list(row.arcs).push([1, 1]); list(row.translatedArcs).push([1, 1]); }
		if (defect === "line-counter") obj(obj(process.lines)["script/main.py"])["1"] = 0;
		const verified = verifyChanged(f, receipt);
		expect(verified.exit).toBe(2);
		expect(verified.result.complete).toBe(false);
	} finally { f.cleanup(); }
}, 120_000);

test("unexecuted Python files retain legitimate empty traces and uncovered counters", () => {
	const f = collected({ "script/main.py": "print(42)\n", "script/unexecuted.py": "print(7)\n" }, cli("script/main.py", "python"));
	try {
		expect(f.exit).toBe(1);
		expect(f.result.complete).toBe(true);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const process = obj(list(receipt.processes)[0]);
		expect(obj(obj(process.trace).files)["script/unexecuted.py"]).toEqual({ arcs: [], translatedArcs: [] });
		expect(process.loaded).toEqual(["script/main.py"]);
		expect(verifyChanged(f, receipt).exit).toBe(1);
	} finally { f.cleanup(); }
}, 120_000);

test("the frozen Python runner source is never credited with its own driver frames", () => {
	const driver = readFileSync(join(import.meta.dir, "quality-coverage/python.py"), "utf8");
	const f = fixture({ "script/main.py": "print(42)\n", "script/quality-coverage/python.py": driver }, cli("script/main.py", "python"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], undefined, { D945_ASSET_DIRECTORY: join(f.root, "script/quality-coverage") });
		expect(run.exit).toBe(1);
		expect(run.result.complete).toBe(true);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const process = obj(list(receipt.processes)[0]);
		expect(process.loaded).toEqual(["script/main.py"]);
		expect(obj(obj(process.trace).files)["script/quality-coverage/python.py"]).toEqual({ arcs: [], translatedArcs: [] });
	} finally { f.cleanup(); }
}, 120_000);

test("a dependency program under node_modules runs natively instead of needing a frozen entry", () => {
	const f = fixture({
		"script/main.ts": 'import assert from "node:assert/strict"; const child = Bun.spawnSync([process.execPath, "node_modules/dep/bin/cli.js"], { stdout: "pipe" }); assert.equal(child.exitCode, 0); assert.equal(child.stdout.toString(), "dep\\n");',
	}, cli("script/main.ts"));
	f.put("node_modules/dep/bin/cli.js", 'console.log("dep");\n');
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		expect(run.result.complete).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test("a failing checker CLI under an outer collection leaves no failure file for the inherited process identity", () => {
	const f = fixture();
	const outer = realpathSync(mkdtempSync(join(tmpdir(), "d945-outer-")));
	try {
		const run = f.run(["--plan-sha256", "0".repeat(64)], undefined, { D945_DIRECTORY: outer, D945_PROCESS: "outer-1" });
		expect(run.exit).toBe(2);
		expect(existsSync(join(outer, "outer-1.failure.json"))).toBe(false);
	} finally { f.cleanup(); rmSync(outer, { recursive: true, force: true }); }
}, 120_000);

test("an unselected collection ignores an inherited outer D945_SOURCE_ROOT for its Python launches", () => {
	const f = fixture({ "script/main.py": "print(42)\n" }, cli("script/main.py", "python"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], undefined, { D945_SOURCE_ROOT: join(f.root, "elsewhere") });
		expect(run.exit).toBe(0);
		expect(run.result.complete).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test("Python static branch counters must agree with the flushed raw arc set", () => {
	const f = collected({ "script/main.py": "def choose(x):\n    if x:\n        return 1\n    return 0\nchoose(True)\nchoose(False)\n" }, cli("script/main.py", "python"));
	try {
		expect(f.exit).toBe(0);
		const original = readFileSync(join(f.root, "coverage.json"), "utf8");
		for (const defect of ["counter", "arcs"]) {
			const receipt = obj(decode(original));
			const process = obj(list(receipt.processes)[0]);
			const row = obj(obj(obj(process.trace).files)["script/main.py"]);
			if (defect === "counter") obj(obj(obj(process.coverage)["script/main.py"]).b)["0"] = [0, 1];
			// Both destinations still execute. Only their predecessor changes, so
			// this cannot be rejected just by comparing covered line sets.
			if (defect === "arcs") for (const key of ["arcs", "translatedArcs"])
				row[key] = list(row[key]).map((arc) => list(arc)[0] === 2 && list(arc)[1] === 3 ? [-1, 3] : arc);
			expect(verifyChanged(f, receipt).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test("only a signal-terminated Python child may omit its normal trace", () => {
	const f = fixture({ "script/main.ts": 'Bun.spawnSync([process.env.D945_PYTHON,"script/child.py"]);', "script/child.py": 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n' }, cli("script/main.ts"));
	try {
		const receipt = collectReceipt(f);
		const child = pythonProcess(receipt);
		expect(child.trace).toBe(null);
		expect(child.signal).toBe("SIGKILL");
		expect(verifyChanged(f, receipt).exit).toBe(0);
		for (const exitCode of [0, 1]) {
			const normal = obj(decode(JSON.stringify(receipt)));
			const process = pythonProcess(normal);
			process.signal = null; process.exitCode = exitCode;
			expect(verifyChanged(f, normal).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test("a frozen Python entry launched in isolated mode is credited and stays isolated", () => {
	const f = fixture({ "script/main.ts": 'import assert from "node:assert/strict"; const child=Bun.spawnSync([process.env.D945_PYTHON,"-I","script/child.py"],{stdout:"pipe",stderr:"pipe"}); assert.equal(child.exitCode,0,child.stderr.toString()); assert.equal(child.stdout.toString(),"1\\n");', "script/child.py": 'import sys\nprint(sys.flags.isolated)\n' }, cli("script/main.ts"));
	try {
		const child = pythonProcess(collectReceipt(f));
		expect(child.entry).toBe("script/child.py");
		expect(child.exitCode).toBe(0);
		expect(obj(child.trace).flushed).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test("embedded Python raw Unicode retains exact source identity through Bun loading", () => {
	const source = "# \u2014\nprint(42)\n";
	const f = fixture({ "script/main.ts": `import assert from "node:assert/strict"; const PYTHON_DRIVER=String.raw\`${source}\`; const child=Bun.spawnSync([process.env.D945_PYTHON,"-u","-c",PYTHON_DRIVER],{stdout:"pipe"}); assert.equal(child.exitCode,0); assert.equal(child.stdout.toString(),"42\\n");` }, cli("script/main.ts"));
	try {
		const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
		inventory.embedded = [{ path: "script/main.ts#PYTHON_DRIVER", sha256: sha256(source), bytes: Buffer.byteLength(source), category: "production", language: "python" }];
		refreeze(f, "inventory", inventory);
		const child = pythonProcess(collectReceipt(f));
		expect(child.entry).toBe("script/main.ts#PYTHON_DRIVER");
		expect(obj(child.trace).flushed).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test.each([1, 2])("v%i retains all-test and operational CLI omission rejection", (version) => {
	for (const omitted of ["test", "cli"]) {
		const f = fixture({ ...fixtures, "script/entry.ts": "if (import.meta.main) console.log(1);\n" });
		try {
			const commands = omitted === "test" ? cli("script/entry.ts") : defaultPlan;
			refreeze(f, "plan", { version, commands: decode(JSON.stringify(commands)) });
			const result = f.run(["--collect"]);
			expect(result.exit).toBe(2);
			expect(result.result.complete).toBe(false);
			expect(obj(list(result.result.errors)[0]).code).toBe("plan");
			expect(obj(list(result.result.errors)[0]).path).toBe(omitted === "test" ? "script/subject.test.ts" : "script/entry.ts");
		} finally { f.cleanup(); }
	}
});

test("v3 executes selected roots in two workspaces and retains exact uncovered inventory", () => {
	const sources = {
		"script/one/main.test.ts": 'import {test,expect} from "bun:test"; import {answer} from "../shared"; test("one",async ()=>{ expect(process.cwd().endsWith("/script/one")).toBe(true); expect(answer()).toBe(42); const child=Bun.spawnSync([process.execPath,"../child.ts"],{stdout:"pipe"}); expect(child.exitCode).toBe(0); expect(child.stdout.toString()).toBe("child\\n"); await Bun.write("effect.txt","one"); });\n',
		"script/two/main.test.ts": 'import {test,expect} from "bun:test"; import {readFileSync,writeFileSync} from "node:fs"; test("two",()=>{ expect(process.cwd().endsWith("/script/two")).toBe(true); expect(readFileSync("../one/effect.txt","utf8")).toBe("one"); writeFileSync("effect.txt","two"); });\n',
		"script/shared.ts": "export function answer(){ return 42; }\n",
		"script/child.ts": 'console.log("child");\n',
		"script/unselected.test.ts": 'import {test} from "bun:test"; test("unselected",()=>{ throw new Error("not selected"); });\n',
		"script/unused.ts": "if (import.meta.main) console.log(7);\n",
	};
	const f = fixture(sources);
	const plan = { version: 3, commands: ["one", "two"].map((name) => ({ id: name, kind: "test", paths: [`script/${name}/main.test.ts`], args: [], cwd: `script/${name}`, runtime: "bun", expectedExitCode: 0 })), run: { id: "selected-run", selectionHash: sha256("selection") } };
	try {
		refreeze(f, "plan", plan);
		const result = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(result.exit).toBe(1);
		expect(result.result.complete).toBe(true);
		expect(readFileSync(join(f.root, "script/two/effect.txt"), "utf8")).toBe("two");
		const rows = list(result.result.measurements).map(obj);
		expect(rows.map((row) => row.path).sort()).toEqual(Object.keys(sources).sort());
		for (const path of ["script/unused.ts", "script/unselected.test.ts"]) {
			const counters = obj(obj(rows.find((row) => row.path === path)).metrics);
			expect(obj(counters.statements).covered).toBe(0);
			expect(obj(counters.statements).total).toBeGreaterThan(0);
		}
		const shared = obj(obj(rows.find((row) => row.path === "script/shared.ts")).metrics);
		expect(obj(shared.statements).covered).toBe(obj(shared.statements).total);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		expect(list(receipt.processes)).toHaveLength(3);
		expect(list(receipt.processes).map(obj).filter((p) => p.parent === "").map((p) => p.cwd).sort()).toEqual(["script/one", "script/two"]);
		for (const defect of ["root", "child", "command", "cwd", "map"]) {
			const changed = obj(decode(JSON.stringify(receipt))), processes = list(changed.processes).map(obj);
			if (defect === "root") changed.processes = processes.filter((p) => p.command !== "two");
			if (defect === "child") changed.processes = processes.filter((p) => p.parent === "");
			if (defect === "command") changed.commands = list(changed.commands).slice(1);
			if (defect === "cwd") obj(processes.find((p) => p.command === "one" && p.parent === "")).cwd = "script/two";
			if (defect === "map") obj(list(changed.maps)[0]).mapHash = "0".repeat(64);
			expect(verifyChanged(f, changed).exit).toBe(2);
		}
		symlinkSync(join(f.root, "script/one"), join(f.root, "alias"));
		for (const cwd of ["../outside", "/tmp", "script/one/..", "script//one", "script/missing", "script/shared.ts", "alias", "script/two"]) {
			refreeze(f, "plan", { ...plan, commands: plan.commands.map((command, index) => index === 0 ? { ...command, cwd } : command) });
			expect(f.run(["--collect"]).exit).toBe(2);
		}
		for (const run of [null, { id: "", selectionHash: sha256("selection") }, { id: "run", selectionHash: "bad" }]) {
			refreeze(f, "plan", { ...plan, run });
			expect(f.run(["--collect"]).exit).toBe(2);
		}
		refreeze(f, "plan", { ...plan, run: { ...plan.run, id: "stale" } });
		expect(verifyChanged(f, receipt).exit).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("a missing test entry and update mode are analysis errors", () => {
	const f = fixture(fixtures, [
		{ id: "only-cli", kind: "cli", paths: ["script/subject.ts"], args: [], expectedExitCode: 0 },
	]);
	try {
		expect(f.run(["--collect"]).exit).toBe(2);
		expect(f.run(["--update"]).exit).toBe(2);
	} finally {
		f.cleanup();
	}
});


test("metrics consumes the actual verified collector receipt without fabricated coverage", async () => {
	const f = collected();
	try {
		expect(f.exit).toBe(0);
		const argv = [process.execPath, join(import.meta.dir, "check-quality-metrics.ts"),
			"--root", f.root, "--inventory", join(f.root, "inventory.json"),
			"--coverage", join(f.root, "coverage.json"), "--contract", join(f.root, "contract.json"),
			"--plan", join(f.root, "plan.json")];
		const paths = { root: f.root, inventory: join(f.root, "inventory.json"), coverage: join(f.root, "coverage.json"), contract: join(f.root, "contract.json"), plan: join(f.root, "plan.json") };
		const verified = coverageForMetrics(paths);
		expect(verified.processes).toHaveLength(1);
		expect(verified.files.map((file) => file.path)).toEqual(["script/subject.test.ts", "script/subject.ts"]);
		expect(verified.files.every((file) => Object.keys(file.mapped.statementMap).length > 0)).toBe(true);
		const child = Bun.spawnSync(argv, { timeout: 60_000 });
		expect(child.stderr.toString()).toBe("");
		expect(child.exitCode).toBe(0);
		const result = obj(decode(child.stdout.toString()));
		expect(result.complete).toBe(true);
		const api = await metrics(argv.slice(2));
		expect(list(result.records)).toEqual(list(decode(JSON.stringify(api.records))));
		expect(list(result.findings)).toEqual(list(decode(JSON.stringify(api.findings))));
		const selected = list(result.records).map(obj).find((row) => row.name === "select");
		expect(obj(selected).crap).toBe(2);
		expect(obj(obj(selected).coverage).fraction).toBe(1);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		receipt.processes = [];
		writeFileSync(join(f.root, "coverage.json"), JSON.stringify(receipt));
		const corrupted = Bun.spawnSync(argv, { timeout: 60_000 });
		expect(corrupted.exitCode).toBe(2);
		expect(() => coverageForMetrics(paths)).toThrow();
	} finally { f.cleanup(); }
}, 120_000);

test("decode rejects invalid escapes and leading zeros while accepting unicode escapes", () => {
	expect(decode('"a\\u0041b"')).toBe("aAb");
	expect(decode('[1, -0.5, 2e3, "x\\n"]')).toEqual([1, -0.5, 2000, "x\n"]);
	for (const text of ['"\\q"', "01", '"\\u12"', '"unterminated', '"raw\ttab"', "[1,]", '{"a":1,}', "1 2"]) {
		let thrown: unknown;
		try { decode(text); } catch (error) { thrown = error; }
		expect(obj(thrown as Json).code, text).toBe("schema");
	}
});

test("shared emission cache serves a second process the same verified identity", () => {
	const f = emittedWorkspace(
		"export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose } from "@fixture/emitted"; import { Worker } from "node:worker_threads"; test("emitted entry", async () => { expect(choose(true)).toBe(42); const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("exit", () => resolve())); });\n',
	);
	try {
		f.put("script/worker.ts", 'import { choose } from "@fixture/emitted"; export const ready = choose(false);\n');
		const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
		list(inventory.files).push({ path: "script/worker.ts", sha256: sha256(readFileSync(join(f.root, "script/worker.ts"))), bytes: readFileSync(join(f.root, "script/worker.ts")).byteLength, category: "tooling", language: "typescript" });
		list(inventory.files).sort((a, b) => str(obj(a).path).localeCompare(str(obj(b).path)));
		f.put("inventory.json", JSON.stringify(inventory));
		f.args[f.args.indexOf("--inventory-sha256") + 1] = sha256(readFileSync(join(f.root, "inventory.json")));
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(run.result.complete).toBe(true);
		const processes = list(obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8"))).processes).map(obj);
		expect(processes).toHaveLength(2);
		for (const process of processes) expect(list(process.loaded).map(str)).toContain("script/pkg/src/index.ts");
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector runs an inline runtime evaluation as an external utility", () => {
	const f = fixture({ "script/utility.ts": 'const run = Bun.spawnSync([process.execPath, "-e", "process.stdout.write(\'ok\')"], { stdout: "pipe", stderr: "pipe" }); if (run.stdout.toString() !== "ok") process.exit(7);\n' }, cli("script/utility.ts"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], checker, { PATH: "/usr/bin:/bin" });
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(run.result.complete).toBe(true);
		expect(list(obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8"))).processes)).toHaveLength(1);
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector admits a receipt-less executable outside the frozen root and refuses one inside", () => {
	const source = 'const run = Bun.spawnSync(["fixture-tool", "print"], { stdout: "pipe", stderr: "pipe" }); if (run.stdout.toString().trim() !== "fixture-tool print") process.exit(7);\n';
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "d945-outside-")));
	const f = fixture({ "script/utility.ts": source }, cli("script/utility.ts"));
	try {
		for (const directory of [outside, join(f.root, "fake-bin")]) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "fixture-tool"), '#!/bin/sh\necho "fixture-tool $@"\n');
			chmodSync(join(directory, "fixture-tool"), 0o755);
		}
		const admitted = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], checker, { PATH: `${outside}:/usr/bin:/bin` });
		if (admitted.exit !== 1) throw new Error(JSON.stringify({ exit: admitted.exit, result: admitted.result, stderr: admitted.stderr }));
		expect(admitted.result.complete).toBe(true);
		const refused = f.run(["--collect"], checker, { PATH: `${join(f.root, "fake-bin")}:/usr/bin:/bin` });
		expect(refused.exit).toBe(2);
		expect(JSON.stringify(refused.result)).toContain("unregistered native executable");
		// A name that resolves nowhere is the operating system's refusal, observed by the caller.
		const missing = f.run(["--collect"], checker, { PATH: "/usr/bin:/bin" });
		expect(missing.exit).toBe(2);
		expect(JSON.stringify(missing.result)).toContain("ENOENT");
		expect(JSON.stringify(missing.result)).not.toContain("cannot be resolved");
	} finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }); }
}, 120_000);

test("instrumented child processes report the command the caller asked for", () => {
	const f = fixture({ "script/utility.ts": 'import { spawn } from "node:child_process"; const child = spawn("tail", ["-n", "1", "/dev/null"]); if (child.spawnfile !== "tail" || JSON.stringify(child.spawnargs) !== JSON.stringify(["tail", "-n", "1", "/dev/null"])) process.exit(7); await new Promise((resolve) => child.once("exit", resolve));\n' }, cli("script/utility.ts"));
	try {
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], checker, { PATH: "/usr/bin:/bin" });
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(run.result.complete).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test("a failed lane message keeps each failing test's error block, not a tail", () => {
	const stderr = [
		"test/a.test.ts:",
		"(pass) fine [1ms]",
		"12 | expect(value).toBe(1)",
		"error: expect(received).toBe(expected)",
		"      at test/a.test.ts:12:3",
		"(fail) a > breaks [2ms]",
		"(pass) later [1ms]",
		"",
		" 2 pass",
		" 1 fail",
	].join("\n");
	expect(failureExcerpt(stderr)).toBe(
		"12 | expect(value).toBe(1)\nerror: expect(received).toBe(expected)\n      at test/a.test.ts:12:3\n(fail) a > breaks [2ms]",
	);
	expect(failureExcerpt("no test summary")).toBe("no test summary");
	expect(failureExcerpt(`${"x".repeat(20_000)}\n(fail) huge [1ms]`)).toHaveLength(16_000);
});
