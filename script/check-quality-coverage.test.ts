import { expect, mock, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as modules from "node:module";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as workerThreads from "node:worker_threads";
import ts from "typescript";
import { z } from "zod";
import { collectorDirectory, coverageForMetrics, decode, exactMetric, sha256, failureExcerpt, launchEntry, preload, preparedFrom, qualityCoverageMain, syntax } from "./check-quality-coverage";
import { run as metrics } from "./check-quality-metrics";
import { statementCounters } from "./quality-ci-bound";
import { workerExecArgv } from "./quality-coverage/worker";
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
	// The checker runs in this process so native coverage observes the collector
	// itself; only its instrumented commands are children. The environment
	// override reaches those children exactly as a spawned checker's would.
	function run(extra: string[] = [], environment: NodeJS.ProcessEnv = {}) {
		return inEnvironment(environment, async () => {
			let stdout = "";
			let stderr = "";
			const log = spyOn(console, "log").mockImplementation((line: string) => { stdout += `${line}\n`; });
			const errors = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
				stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
				return true;
			});
			try {
				const exit = await qualityCoverageMain([...args, ...extra]);
				return { exit, result: obj(decode(stdout)), stderr };
			} finally {
				log.mockRestore();
				errors.mockRestore();
			}
		});
	}
	return { root, put, args, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function inEnvironment<T>(environment: NodeJS.ProcessEnv, action: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	try {
		return await action();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
/** The value a synchronous action throws, or null when it returns. */
function thrown(action: () => void): Promise<Json> {
	return Promise.resolve().then(action).then((): Json => null, (error: Json) => error);
}
const moduleLoader: {
	createRequire(path: string): (id: "node:worker_threads") => { Worker: typeof workerThreads.Worker };
} = modules;
// The runtime's own Worker class: an observing collector installs a subclass of
// it, so the native class is the one that extends EventEmitter directly.
function nativeWorker(Worker: typeof workerThreads.Worker): typeof workerThreads.Worker {
	if (Object.getPrototypeOf(Worker) === EventEmitter) return Worker;
	// Not the native class, so the class it extends is a Worker class as well.
	const parent: typeof workerThreads.Worker = Object.getPrototypeOf(Worker);
	return nativeWorker(parent);
}
// Running the preload here hands this process the instrumented child's role. The
// interposition it installs is undone afterwards so later tests launch natively.
// Under the exact lane this process is itself observed, and the observer's Worker
// judges every target against an inventory that cannot hold the fixture. The
// preload under test interposes the runtime that loads it, so it installs over the
// native class; the observer's class returns with the rest.
function interposition(): () => void {
	const workerModule = moduleLoader.createRequire(import.meta.url)("node:worker_threads");
	const launches = ["spawn", "spawnSync", "execFile", "execFileSync", "fork", "exec", "execSync"] as const;
	const saved = {
		spawn: Bun.spawn,
		spawnSync: Bun.spawnSync,
		processes: launches.map((name) => [name, childProcess[name]] as const),
		Worker: workerModule.Worker,
		coverage: globalThis.__d945Coverage,
	};
	const installWorker = (Worker: typeof workerThreads.Worker) => {
		workerModule.Worker = Worker;
		syncBuiltinESMExports();
		mock.module("node:worker_threads", () => ({ ...workerThreads, Worker, default: workerThreads }));
	};
	installWorker(nativeWorker(saved.Worker));
	return () => {
		Object.defineProperty(Bun, "spawn", { value: saved.spawn });
		Object.defineProperty(Bun, "spawnSync", { value: saved.spawnSync });
		for (const [name, value] of saved.processes) Object.defineProperty(childProcess, name, { value });
		mock.module("node:child_process", () => ({ ...childProcess, default: childProcess }));
		installWorker(saved.Worker);
		globalThis.__d945Coverage = saved.coverage;
	};
}
const Chooser = z.function({ input: [z.boolean()], output: z.number() });
const FrozenMain = z.object({ pick: Chooser });
const EmittedBarrel = z.object({ choose: Chooser });
// Bun's declared option types omit `shell`; the interposition still refuses it.
type LooseSpawnSync = (command: string[], options: { shell?: boolean; stdout?: "pipe" }) => { exitCode: number };

test("a Node worker inherits execArgv without the parent's preload import, then imports its own", () => {
	expect(workerExecArgv([], "file:///d/preload.mjs")).toEqual(["--import", "file:///d/preload.mjs"]);
	expect(workerExecArgv(["--import", "file:///p/preload.mjs", "--no-warnings"], "file:///d/preload.mjs")).toEqual(["--no-warnings", "--import", "file:///d/preload.mjs"]);
	expect(workerExecArgv(["--import=file:///p/preload.mjs", "--import", "data:text/javascript,", "--stack-size=100"], "file:///d/preload.mjs")).toEqual(["--import", "data:text/javascript,", "--stack-size=100", "--import", "file:///d/preload.mjs"]);
});

test("the preload interposes the runtime that loads it", async () => {
	const f = emittedWorkspace(undefined, undefined, {
		"script/main.ts": "export function pick(taken: boolean): number {\n  if (taken) return 1;\n  return 2;\n}\n",
		"script/child.ts": 'import { value } from "./pkg/dist/value.js";\nif (value !== 42) process.exit(3);\n',
		"script/worker.ts": 'import { pick } from "./main";\nexport const ready = pick(false);\n',
	}, [...defaultPlan, ...cli("script/child.ts")]);
	const directory = await collectorDirectory({ root: f.root, contract: join(f.root, "contract.json"), inventory: join(f.root, "inventory.json"), plan: join(f.root, "plan.json") });
	const id = "in-process";
	const record = (name: string): Json => decode(readFileSync(join(directory, `${name}.json`), "utf8"));
	const children = (): string[] => list(record(`${id}.children`)).map(str);
	writeFileSync(join(directory, `${id}.request.json`), JSON.stringify({ parent: "outer", command: "cli", runtime: "bun", entry: "script/main.ts", args: [], binary: process.execPath, version: Bun.version, sha256: sha256(readFileSync(process.execPath)) }));
	const restore = interposition();
	try {
		await inEnvironment({ D945_PROCESS: id, D945_PARENT: "outer" }, async () => {
			preload(directory);
			expect(record(`${id}.start`)).toEqual({ id, parent: "outer", pid: process.pid, runtime: "bun", entry: "script/main.ts" });
			expect(children()).toEqual([]);

			// A launch of frozen inventory is wrapped, registered and observed; the child's
			// emission proof for value.js is then shared with this process.
			const child = Bun.spawnSync([process.execPath, "script/child.ts"], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
			if (child.exitCode !== 0) throw new FixtureError(child.stderr.toString());
			const childId = children()[0] ?? "";
			expect(childId).not.toBe("");
			expect(obj(record(`${childId}.request`)).parent).toBe(id);
			expect(record(`${childId}.observed`)).toEqual({ exitCode: 0, signal: null });
			expect(list(record(`${childId}.emitted`))).toHaveLength(1);

			// An external program runs natively without a request; a shell cannot hide one;
			// a launch already registered here passes through untouched.
			expect(Bun.spawnSync([process.execPath, "--version"], { stdout: "pipe" }).exitCode).toBe(0);
			const interposedSpawnSync: LooseSpawnSync = Bun.spawnSync;
			expect(await thrown(() => interposedSpawnSync(["git", "--version"], { shell: true }))).toEqual({ code: "unsupported_process", path: "git", message: "shell execution is not observable" });
			const passthrough = Bun.spawn({ cmd: [process.execPath, "--version"], env: { ...process.env, D945_PROCESS: childId }, stdout: "pipe" });
			expect(await passthrough.exited).toBe(0);
			expect(children()).toEqual([childId]);

			// node:child_process launches are the same wrapped launches, reported as asked.
			const sync = childProcess.spawnSync(process.execPath, ["script/child.ts"], { cwd: f.root, stdio: "pipe" });
			expect(sync.status).toBe(0);
			const spawned = childProcess.spawn(process.execPath, ["script/child.ts"], { cwd: f.root, stdio: "pipe" });
			expect(spawned.spawnfile).toBe(process.execPath);
			expect(spawned.spawnargs).toEqual([process.execPath, "script/child.ts"]);
			const exit = new Promise<number | null>((resolve) => spawned.once("exit", resolve));
			expect(await exit).toBe(0);
			expect(childProcess.spawnSync(process.execPath, ["--version"], { stdio: "pipe" }).status).toBe(0);
			expect(children()).toHaveLength(3);
			for (const launched of children()) expect(record(`${launched}.observed`)).toEqual({ exitCode: 0, signal: null });

			// Frozen source loads as its prepared instrumentation whose counters persist here;
			// a compiled module is proved (index.js) or served from the shared proof (value.js).
			const main = await import(pathToFileURL(join(f.root, "script/main.ts")).href).then(FrozenMain.parse);
			expect(main.pick(true)).toBe(1);
			expect(record(`${id}.loaded`)).toEqual(["script/main.ts"]);
			const counts = readFileSync(join(directory, `${id}.counts.bin`));
			expect(Array.from(new Float64Array(counts.buffer, counts.byteOffset, counts.length / 8)).some((n) => n > 0)).toBe(true);
			const barrel = await import(pathToFileURL(join(f.root, "script/pkg/dist/index.js")).href).then(EmittedBarrel.parse);
			expect(barrel.choose(true)).toBe(42);
			const proofs = list(record(`${id}.emitted`)).map(obj);
			expect(proofs.map((proof) => proof.path)).toEqual(["script/pkg/dist/index.js", "script/pkg/dist/value.js"]);
			expect(proofs[1]).toEqual(obj(list(record(`${childId}.emitted`))[0]));
			// Sources transfer in module evaluation order: the dependency before its barrel.
			expect(record(`${id}.transferred`)).toEqual(["script/pkg/src/value.ts", "script/pkg/src/index.ts"]);
			const registry = globalThis.__d945Coverage ?? {};
			expect(await thrown(() => { registry["script/worker.ts"] = { path: "script/worker.ts", statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} }; })).toEqual({ code: "source_map", path: "script/worker.ts", message: "instrumented code changed its map" });

			// A worker is a child execution context with its own identity, bootstrapped
			// through the preload; unref would let it escape observation.
			const worker = new workerThreads.Worker(pathToFileURL(join(f.root, "script/worker.ts")));
			expect(await thrown(() => worker.unref())).toEqual({ code: "unsupported_process", path: children()[3] ?? "", message: "worker unref is not observable" });
			const code = await new Promise<number>((resolve) => worker.once("exit", resolve));
			expect(code).toBe(0);
			const workerId = children()[3] ?? "";
			expect(record(`${workerId}.observed`)).toEqual({ exitCode: 0, signal: null });
			expect(record(`${workerId}.loaded`)).toEqual(["script/main.ts", "script/worker.ts"]);
			expect(readFileSync(join(directory, `${workerId}.worker.mjs`), "utf8")).toContain("preload.js");
			worker.emit("error", new Error("late"));
			expect(await thrown(() => new workerThreads.Worker(new URL("data:text/javascript,")))).toEqual({ code: "unsupported_process", path: id, message: "worker target must be a file URL" });
			expect(await thrown(() => new workerThreads.Worker(pathToFileURL(join(f.root, "script/absent.ts"))))).toEqual({ code: "unsupported_process", path: "script/absent.ts", message: "worker target is absent from frozen language inventory" });
		});
	} finally {
		restore();
		rmSync(directory, { recursive: true, force: true });
		f.cleanup();
	}
}, 120_000);
async function collected(sources: Record<string, string> = fixtures, plan = defaultPlan) {
	const f = fixture(sources, plan);
	const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
	return { ...f, ...run };
}
test("exact collector observes an inventoried worker as a child execution context", async () => {
	const f = fixture({
		"script/shared.ts": "export const shared = 1;\n",
		"script/worker.ts": 'import { shared } from "./shared"; export const ready = shared;\n',
		"script/subject.ts": 'import { shared } from "./shared"; import { Worker } from "node:worker_threads"; void shared; const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("exit", () => resolve()));\n',
		"script/subject.test.ts": 'import { test } from "bun:test"; import "./subject"; test("worker", () => {});\n',
	}, [{ id: "tests", kind: "test", paths: ["script/subject.test.ts"], args: [], expectedExitCode: 0 }]);
	try {
		const [root, worker] = rootAndWorker(await collectReceipt(f), "missing worker receipt");
		expect(worker.pid).toBe(root.pid);
		expect(list(worker.loaded).map(str)).toContain("script/shared.ts");
		expect(list(root.loaded).map(str)).toContain("script/shared.ts");
	} finally { f.cleanup(); }
}, 120_000);
test("exact collector observes a Node worker with inherited preload identity", async () => {
	const f = fixture({
		"script/shared.ts": "export const shared = 1;\n",
		"script/worker.ts": 'import { shared } from "./shared"; export const ready = shared;\n',
		"script/subject.ts": 'import { shared } from "./shared"; import { Worker } from "node:worker_threads"; void shared; const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("exit", () => resolve()));\n',
	}, cli("script/subject.ts", "node"));
	try {
		const [root, worker] = rootAndWorker(await collectReceipt(f), "missing Node worker receipt");
		expect(worker.runtime).toBe("node");
		expect(worker.pid).toBe(root.pid);
		expect(list(worker.loaded).map(str)).toContain("script/worker.ts");
	} finally { f.cleanup(); }
}, 120_000);
test("exact collector rejects a worker with an unapproved nonzero exit", async () => {
	const f = fixture({
		"script/worker.ts": 'throw new Error("worker failure");\n',
		"script/subject.ts": 'import { Worker } from "node:worker_threads"; const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("error", () => resolve()));\n',
	}, cli("script/subject.ts", "node"));
	try {
		const run = await f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("worker failure");
	} finally { f.cleanup(); }
}, 120_000);
function findings(result: { [key: string]: Json }): { [key: string]: Json }[] {
	return list(result.findings).map(obj);
}

test.each(["original", "changed-source", "changed-emit"] as const)("NamedError exact transfer preserves Schema independence or refuses changed identity: %s", async (mode) => {
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
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
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

test("exact collector permits only canonical git and kill utilities without process receipts", async () => {
	const source = `import { spawnSync } from "node:child_process";
const git = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
const kill = spawnSync("/bin/kill", ["-0", String(process.pid)], { stdio: "ignore" });
if (git.exitCode !== 0 || kill.status !== 0) process.exit(7);
`;
	await collectUtility(source);
}, 120_000);

test("exact collector permits canonical system shells and POSIX utilities without receipts", async () => {
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
	await collectUtility(source);
}, 120_000);

test("exact collector runs an owned runtime entry outside the frozen root or an unfrozen inline program or a runtime probe natively, without credit or receipt", async () => {
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
	await collectUtility(source);
	const inside = fixture({ "script/utility.ts": source }, [{ id: "cli", kind: "cli", paths: ["script/utility.ts"], args: ["inside"], expectedExitCode: 0, runtime: "bun" }]);
	try {
		const run = await inside.run(["--collect"], { PATH: "/usr/bin:/bin" });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("entry/source is absent from frozen language inventory");
	} finally { inside.cleanup(); }
	const options = fixture({ "script/utility.ts": source }, [{ id: "cli", kind: "cli", paths: ["script/utility.ts"], args: ["options"], expectedExitCode: 0, runtime: "bun" }]);
	try {
		const run = await options.run(["--collect"], { PATH: "/usr/bin:/bin" });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("unregistered interpreter option --smol");
	} finally { options.cleanup(); }
}, 180_000);

// git is a permitted canonical utility and tar a permitted POSIX one; neither
// permission follows a copy planted inside the frozen root.
test.each(["tar", "git"])("exact collector rejects a %s executable planted inside the frozen root", async (utility) => {
	const f = fixture({ "script/utility.ts": `Bun.spawnSync(["${utility}", "--version"]);\n` }, cli("script/utility.ts"));
	try {
		const run = await f.run(["--collect"], { PATH: plantedPath(f, utility) });
		expect(run.exit).toBe(2);
		expect(JSON.stringify(run.result)).toContain("unregistered native executable");
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector permits bunx only when it is the pinned Bun binary", async () => {
	const f = fixture({ "script/utility.ts": 'if (Bun.spawnSync(["bunx", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) process.exit(7);\n' }, cli("script/utility.ts"));
	try {
		const run = await f.run(["--collect"], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` });
		if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		const rejected = await f.run(["--collect"], { PATH: plantedPath(f, "bunx") });
		expect(rejected.exit).toBe(2);
		expect(JSON.stringify(rejected.result)).toContain("unregistered native executable");
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector does not turn a utility into a shell escape", async () => {
	const f = fixture({ "script/utility.ts": 'Bun.spawn(["git", "--version"], { shell: true });\n' }, cli("script/utility.ts"));
	try {
		const run = await f.run(["--collect"], { PATH: "/usr/bin:/bin" });
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
		const collected = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
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
	sources: Record<string, string> = {},
	commands: Command[] = defaultPlan,
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
		...sources,
	}, commands);
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
	inventory.configurations = ["script/pkg/package.json", "script/tsconfig.json", "tsconfig.base.json"].map((path) => ({ path, sha256: sha256(readFileSync(join(f.root, path))) }));
	f.put("inventory.json", JSON.stringify(inventory));
	for (const name of ["inventory", "contract"]) f.args[f.args.indexOf(`--${name}-sha256`) + 1] = sha256(readFileSync(join(f.root, `${name}.json`)));
	return { ...f, source };
}

const dynamicEmittedTest = 'import { test, expect } from "bun:test"; const { choose } = await import("@fixture/emitted"); test("dynamic emitted entry", () => { expect(choose(true)).toBe(42); });\n';
const originalBeforeDynamicTest = 'import { test, expect } from "bun:test"; import { choose as original } from "./pkg/src/index.ts"; const { choose } = await import("@fixture/emitted"); test("both instances", () => { expect(original(true)).toBe(42); expect(choose(false)).toBe(99); });\n';
const parenthesizedEmittedTest = 'import { test, expect } from "bun:test"; const { choose } = await import(("@fixture/emitted")); test("parenthesized", () => { expect(choose(true)).toBe(42); });\n';
const requireEmittedTest = 'import { test, expect } from "bun:test"; const { choose } = require("@fixture/emitted"); test("require", () => { expect(choose(true)).toBe(42); });\n';
const relativeEmittedTest = 'import { test, expect } from "bun:test"; import { choose } from "./pkg/dist/index.js"; test("relative entry", () => { expect(choose(true)).toBe(42); });\n';
const aliasEmittedTest = 'import { test, expect } from "bun:test"; import { choose } from "@fixture/alias"; test("alias entry", () => { expect(choose(true)).toBe(42); });\n';

// Replaces the emitted workspace's package manifest and refreezes its digest.
// Points the `@fixture/emitted` link at a decoy package of the same name
// outside the owned roots.
function retargetPackageLinkToDecoy(f: ReturnType<typeof emittedWorkspace>): void {
	rmSync(join(f.root, "node_modules/@fixture/emitted"));
	f.put("node_modules/decoy/package.json", '{"name":"@fixture/emitted","type":"module","exports":"./index.js"}');
	f.put("node_modules/decoy/index.js", "export function choose(taken) { return taken ? 42 : 99; }\n");
	symlinkSync(join(f.root, "node_modules/decoy"), join(f.root, "node_modules/@fixture/emitted"));
}

function replaceManifest(f: ReturnType<typeof emittedWorkspace>, manifest: string): void {
	f.put("script/pkg/package.json", manifest);
	const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
	inventory.configurations = list(inventory.configurations).map((row) => obj(row).path === "script/pkg/package.json" ? { path: "script/pkg/package.json", sha256: sha256(readFileSync(join(f.root, "script/pkg/package.json"))) } : row);
	refreeze(f, "inventory", inventory);
}

// Collects a complete receipt into `path` and returns its decoded object.
async function collectedReceipt(f: ReturnType<typeof emittedWorkspace>, path: string): Promise<Record<string, Json>> {
	const collected = await f.run(["--collect", "--write-coverage", path]);
	if (collected.exit !== 1) throw new Error(JSON.stringify({ exit: collected.exit, result: collected.result, stderr: collected.stderr }));
	return obj(decode(readFileSync(path, "utf8")));
}

// Collects and asserts the run is refused with an identity error at `path`.
async function collectRefused(f: ReturnType<typeof emittedWorkspace>, path: string, message: string): Promise<void> {
	const run = await f.run(["--collect"]);
	expect(run.exit).toBe(2);
	expect(run.result.complete).toBe(false);
	const error = obj(list(run.result.errors)[0]);
	expect(str(error.path)).toBe(path);
	expect(str(error.message)).toContain(message);
}

// Collects a complete receipt, asserts every process carries exactly the
// expected emission proofs, and returns the exit of verifying that receipt.
async function collectedEmissions(f: ReturnType<typeof emittedWorkspace>, emitted: readonly string[]): Promise<number> {
	const path = join(f.root, "coverage.json");
	const receipt = await collectedReceipt(f, path);
	for (const process of list(receipt.processes).map(obj)) expect(list(process.emitted).map((row) => str(obj(row).path)).sort()).toEqual([...emitted].sort());
	return (await f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))])).exit;
}

// Erased provenance can never keep credit from a changed compiled artifact:
// the frozen tree (static imports of the loaded test and of the compiled
// barrel) and the process's own counters (an evaluated dynamic import) pin
// the proofs a process must carry, whichever records it drops. The binding is
// to the frozen tree, so a specifier that stops resolving, a compiled entry
// retargeted through a symlink, and a package link redirected into the
// dependency tree all fail identity instead of dropping the obligation.
for (const [mode, testSource, message] of [
	["static", undefined, "emitted module imported by script/subject.test.ts has no emission proof"],
	["dynamic", dynamicEmittedTest, "emitted module imported by script/subject.test.ts has no emission proof"],
	["original-before-dynamic", originalBeforeDynamicTest, "emitted module imported by script/subject.test.ts has no emission proof"],
	["parenthesized-literal", parenthesizedEmittedTest, "emitted module imported by script/subject.test.ts has no emission proof"],
	["require", requireEmittedTest, "emitted module imported by script/subject.test.ts has no emission proof"],
	["barrel-child", undefined, "emitted module imported by script/pkg/dist/index.js has no emission proof"],
	["manifest-retarget", undefined, "configuration drift"],
	["relative-deleted-entry", relativeEmittedTest, 'import "./pkg/dist/index.js" does not resolve in the frozen tree'],
	["relative-entry-retarget-original", relativeEmittedTest, "owned tree holds a symlink"],
	["bare-entry-retarget-original", undefined, "owned tree holds a symlink"],
	["package-symlink-retarget", undefined, 'import "@fixture/emitted" resolves outside frozen package script/pkg/package.json'],
] as const) test(`erased emission provenance cannot credit a changed artifact (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n", testSource);
	try {
		const path = join(f.root, "coverage.json");
		const receipt = await collectedReceipt(f, path);
		for (const process of list(receipt.processes).map(obj)) {
			expect(list(process.emitted)).toHaveLength(2);
			// barrel-child keeps the barrel's proof and drops only value.js's.
			const keep = (name: string) => mode === "barrel-child" && !/\/value\.[jt]s$/.test(name);
			process.emitted = list(process.emitted).filter((row) => keep(str(obj(row).path)));
			process.transferred = list(process.transferred).filter((row) => keep(str(row)));
		}
		f.put("coverage.json", JSON.stringify(receipt));
		const valuePath = "script/pkg/dist/value.js";
		f.put(valuePath, readFileSync(join(f.root, valuePath), "utf8").replace("42", "43"));
		if (mode === "manifest-retarget") f.put("script/pkg/package.json", '{"name":"@fixture/emitted","type":"module","exports":"./src/index.ts"}');
		if (mode === "relative-deleted-entry") rmSync(join(f.root, "script/pkg/dist/index.js"));
		if (mode === "relative-entry-retarget-original" || mode === "bare-entry-retarget-original") {
			rmSync(join(f.root, "script/pkg/dist/index.js"));
			symlinkSync("../src/index.ts", join(f.root, "script/pkg/dist/index.js"));
		}
		if (mode === "package-symlink-retarget") retargetPackageLinkToDecoy(f);
		const verified = await f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))]);
		expect(verified.exit).toBe(2);
		expect(verified.result.complete).toBe(false);
		expect(str(obj(list(verified.result.errors)[0]).message)).toContain(message);
	} finally { f.cleanup(); }
}, 120_000);

// A link that reaches an owned package under a name its frozen manifest does
// not declare is not the frozen tree's routing, so it can never be retargeted
// unnoticed: it is refused before any emission proof is weighed.
test("a package link aliasing an owned package under another name fails identity", async () => {
	const f = emittedWorkspace("export const value = 42;\n", aliasEmittedTest);
	try {
		symlinkSync(join(f.root, "script/pkg"), join(f.root, "node_modules/@fixture/alias"));
		const run = await f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain('package link node_modules/@fixture/alias for "@fixture/alias" aliases frozen package script/pkg/package.json');
	} finally { f.cleanup(); }
}, 120_000);

test("a bare specifier routed by an unfrozen package manifest cannot anchor an emission", async () => {
	const f = emittedWorkspace();
	try {
		const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
		inventory.configurations = list(inventory.configurations).filter((row) => obj(row).path !== "script/pkg/package.json");
		refreeze(f, "inventory", inventory);
		const run = await f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain('package link node_modules/@fixture/emitted for "@fixture/emitted" lands in the owned tree without a frozen package of that name');
	} finally { f.cleanup(); }
}, 120_000);

// Only the counters of the import site itself impose the obligation: an
// untaken `if`, an untaken ternary arm and an untaken short-circuit operand
// all carry no proof, while the arm that ran still pins its emission.
for (const [mode, testSource, emitted] of [
	["if", 'import { test, expect } from "bun:test"; if (process.argv.includes("--load-emitted")) await import("@fixture/emitted"); test("untaken", () => { expect(1).toBe(1); });\n', []],
	["ternary-arm", 'import { test, expect } from "bun:test"; const mod = process.argv.includes("--other") ? await import("./pkg/dist/other.js") : await import("./pkg/dist/value.js"); test("one arm", () => { expect(mod.value).toBe(42); });\n', ["script/pkg/dist/value.js"]],
	["short-circuit", 'import { test, expect } from "bun:test"; const ignored = process.argv.includes("--load-emitted") && await import("@fixture/emitted"); test("short circuit", () => { expect(ignored).toBe(false); });\n', []],
] as const) test(`an untaken dynamic import legitimately carries no emission proof (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n", testSource, { "script/pkg/src/other.ts": "export const value = 99;\n" });
	try {
		expect(await collectedEmissions(f, emitted)).toBe(1);
	} finally { f.cleanup(); }
}, 120_000);

// An owned emission whose dependency is named by a computed specifier cannot
// have that dependency pinned, so the emission itself is refused; computed
// specifiers in originals stay the loader's concern.
test("a computed specifier inside an owned emission fails identity", async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose } from "@fixture/emitted"; test("computed child", async () => { expect(await choose()).toBe(42); });\n',
		{ "script/pkg/src/index.ts": 'export async function choose() { const target = "./value.js"; return (await import(target)).value; }\n' });
	try {
		await collectRefused(f, "script/pkg/dist/index.js", "emitted module loads a computed specifier at 1:");
	} finally { f.cleanup(); }
}, 120_000);

// Any reach to the module loader inside an owned emission other than a literal
// `import(...)`/`require(...)` call can load a module the frozen tree does not
// pin, so the emission is refused at collection.
for (const [mode, index, message] of [
	["aliased-require", 'const r = require; export function choose(taken: boolean) { return taken ? r("./value.js").value : 99; }\n', "emitted module reaches the module loader at 1:10"],
	["createRequire", 'import { createRequire } from "node:module"; export function choose(taken: boolean) { return taken ? createRequire(import.meta.url)("./value.js").value : 99; }\n', "emitted module reaches the module loader at 1:0"],
	["import.meta.require", 'export function choose(taken: boolean) { return taken ? import.meta.require("./value.js").value : 99; }\n', "emitted module reaches the module loader at 1:"],
] as const) test(`an owned emission reaching the module loader fails identity (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n", undefined, { "script/pkg/src/index.ts": index });
	try {
		await collectRefused(f, "script/pkg/dist/index.js", message);
	} finally { f.cleanup(); }
}, 120_000);

// The emission's load sites are joined to the original's by position, so a
// type-only wrapper or a rewritten `.ts` extension in the original still
// demands the emitted child the loader actually fetched.
for (const [mode, index] of [
	["as-string", 'export async function choose(taken: boolean) { return taken ? (await import("./value.js" as string)).value : 99; }\n'],
	["non-null", 'export async function choose(taken: boolean) { return taken ? (await import("./value.js"!)).value : 99; }\n'],
] as const) test(`a wrapped literal dynamic import inside an emission still pins its child (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose } from "@fixture/emitted"; test("wrapped child", async () => { expect(await choose(true)).toBe(42); });\n',
		{ "script/pkg/src/index.ts": index });
	try {
		const path = join(f.root, "coverage.json");
		const receipt = await collectedReceipt(f, path);
		for (const process of list(receipt.processes).map(obj)) {
			process.emitted = list(process.emitted).filter((row) => !/\/value\.js$/.test(str(obj(row).path)));
			process.transferred = list(process.transferred).filter((row) => !/\/value\.ts$/.test(str(row)));
		}
		f.put("coverage.json", JSON.stringify(receipt));
		const verified = await f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))]);
		expect(verified.exit).toBe(2);
		expect(str(obj(list(verified.result.errors)[0]).message)).toContain("emitted module imported by script/pkg/dist/index.js has no emission proof");
	} finally { f.cleanup(); }
}, 120_000);

test("a frozen owned package manifest without a name binds no bare specifier", async () => {
	const f = emittedWorkspace();
	try {
		replaceManifest(f, '{"type":"module","exports":"./dist/index.js"}');
		await collectRefused(f, "script/pkg/package.json", "frozen owned package manifest declares no name");
	} finally { f.cleanup(); }
}, 120_000);

// A `require` site resolves under the require conditions, so the emission it
// demands is the one the loader fetched rather than the import entry.
test("a require site demands the emission the require condition selects", async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; const { choose } = require("@fixture/emitted"); test("require condition", () => { expect(choose(true)).toBe(42); });\n',
		{ "script/pkg/src/alt.ts": 'import { value } from "./value.js";\nexport function choose(taken: boolean) { return taken ? value : 99; }\n' });
	try {
		replaceManifest(f, '{"name":"@fixture/emitted","type":"module","exports":{".":{"require":"./dist/alt.js","import":"./dist/index.js"}}}');
		expect(await collectedEmissions(f, ["script/pkg/dist/alt.js", "script/pkg/dist/value.js"])).toBe(1);
	} finally { f.cleanup(); }
}, 120_000);

// A dynamic import the counters cannot decide is refused rather than credited
// as taken or untaken: logical assignment leaves no branch arm behind.
test("a dynamic import without a deciding counter fails identity", async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; let m: { choose(taken: boolean): number } = { choose: () => 42 }; m ||= await import("@fixture/emitted"); test("logical assignment", () => { expect(m.choose(true)).toBe(42); });\n');
	try {
		await collectRefused(f, "script/subject.test.ts", "has no counter that proves it evaluated or skipped");
	} finally { f.cleanup(); }
}, 120_000);

// Erases every emission proof and transferred source from a collected
// receipt, changes the compiled value module, and returns the verification.
async function verifiedAfterErasure(f: ReturnType<typeof emittedWorkspace>, mutate: () => void = () => undefined) {
	const path = join(f.root, "coverage.json");
	const receipt = await collectedReceipt(f, path);
	for (const process of list(receipt.processes).map(obj)) {
		process.emitted = [];
		process.transferred = [];
	}
	f.put("coverage.json", JSON.stringify(receipt));
	const valuePath = "script/pkg/dist/value.js";
	f.put(valuePath, readFileSync(join(f.root, valuePath), "utf8").replace("42", "43"));
	mutate();
	const verified = await f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))]);
	expect(verified.exit).toBe(2);
	expect(verified.result.complete).toBe(false);
	return str(obj(list(verified.result.errors)[0]).message);
}

// A default parameter initializer has its own branch counter, so the site is
// decided: evaluated when the default was taken, skipped when an argument was
// passed.
for (const [mode, call, emitted] of [
	["taken", "pick()", ["script/pkg/dist/index.js", "script/pkg/dist/value.js"]],
	["untaken", "pick({ choose: () => 42 })", []],
] as const) test(`a default parameter initializer is decided by its branch counter (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		`import { test, expect } from "bun:test"; function pick(mod: { choose(taken: boolean): number } = require("@fixture/emitted")) { return mod.choose(true); } test("default parameter", () => { expect(${call}).toBe(42); });\n`);
	try {
		expect(await collectedEmissions(f, emitted)).toBe(1);
		if (mode === "taken") expect(await verifiedAfterErasure(f)).toContain("emitted module imported by script/subject.test.ts has no emission proof");
	} finally { f.cleanup(); }
}, 120_000);

// A literal reaching the loader through `import.meta.resolve`, a
// `new URL(..., import.meta.url)` (with or without `.href`, query ignored) or
// `createRequire(import.meta.url)` names the same module the literal alone
// would, so the site is demanded like a plain literal call.
for (const [mode, load] of [
	["url-href-query", 'await import(new URL("./pkg/dist/value.js?first", import.meta.url).href)'],
	["url-object", 'await import(new URL("./pkg/dist/value.js", import.meta.url))'],
	["import.meta.resolve", 'await import(import.meta.resolve("./pkg/dist/value.js"))'],
	["createRequire", 'createRequire(import.meta.url)("./pkg/dist/value.js")'],
] as const) test(`a decidable loader form in an original demands its emission (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		`import { test, expect } from "bun:test"; import { createRequire } from "node:module"; const { value } = ${load}; test("decidable form", () => { expect(value).toBe(42); });\n`);
	try {
		expect(await collectedEmissions(f, ["script/pkg/dist/value.js"])).toBe(1);
		expect(await verifiedAfterErasure(f)).toContain("emitted module imported by script/subject.test.ts has no emission proof");
	} finally { f.cleanup(); }
}, 120_000);

// An emission that only a computed specifier in an original loaded is pinned
// by no frozen site, so a receipt without its proof would verify; the process
// is refused at collection instead.
test("an emission loaded through a computed specifier in an original fails identity", async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; const target = "./pkg/dist/value.js"; const { value } = await import(target); test("computed", () => { expect(value).toBe(42); });\n');
	try {
		await collectRefused(f, "script/pkg/dist/value.js", "emitted module was loaded through a computed specifier; no frozen load site pins it");
	} finally { f.cleanup(); }
}, 120_000);

// The package scope of the importer routes a bare specifier's self-reference,
// so a manifest planted there after collection cannot retarget the specifier
// onto an original and dissolve the emission's obligation.
for (const [mode, manifest, text] of [
	["root", "package.json", '{"name":"@fixture/emitted","type":"module","exports":{".":"./script/pkg/src/index.ts"}}'],
	["owned", "script/package.json", '{"name":"@fixture/emitted","type":"module","exports":{".":"./pkg/src/index.ts"}}'],
] as const) test(`an unfrozen importer-side package scope cannot retarget a bare specifier (${mode})`, async () => {
	const f = emittedWorkspace();
	try {
		expect(await verifiedAfterErasure(f, () => f.put(manifest, text))).toContain(`package scope manifest ${manifest} routing "@fixture/emitted" is not frozen`);
	} finally { f.cleanup(); }
}, 120_000);

// A frozen `#` entry mapping to a bare package binds that package's link, so
// retargeting the link at verification is refused exactly as the direct bare
// form is; a conditional entry cannot be pinned to one package.
for (const [mode, entry, message] of [
	["bare-target-link-retarget", '"@fixture/emitted"', 'import "@fixture/emitted" resolves outside frozen package script/pkg/package.json'],
	["conditional-entry", '{"default":"./script/pkg/dist/index.js"}', 'imports map entry "#emitted" in package.json is not one literal target'],
] as const) test(`a frozen imports map entry is pinned through its routed target (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose } from "#emitted"; test("imports map", () => { expect(choose(true)).toBe(42); });\n');
	try {
		f.put("package.json", `{"name":"fixture-root","type":"module","imports":{"#emitted":${entry}}}`);
		const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
		inventory.configurations = [...list(inventory.configurations), { path: "package.json", sha256: sha256(readFileSync(join(f.root, "package.json"))) }];
		refreeze(f, "inventory", inventory);
		if (mode === "conditional-entry") await collectRefused(f, "script/subject.test.ts", message);
		else expect(await verifiedAfterErasure(f, () => retargetPackageLinkToDecoy(f))).toContain(message);
	} finally { f.cleanup(); }
}, 120_000);

// A bare specifier's link may land in the owned tree only on the frozen
// manifest directory of that name: a link onto a bare subdirectory of an owned
// package would let the same specifier name a decoy at verification.
test("a package link landing below a frozen package directory fails identity", async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose } from "shim"; test("subdirectory link", () => { expect(choose(true)).toBe(42); });\n');
	try {
		symlinkSync(join(f.root, "script/pkg/dist"), join(f.root, "node_modules/shim"));
		await collectRefused(f, "script/subject.test.ts", 'package link node_modules/shim for "shim" lands in the owned tree without a frozen package of that name');
	} finally { f.cleanup(); }
}, 120_000);

// A relative specifier is pinned by the frozen owned tree only when its
// lexical directory is where the loader lands; a symlink outside the roots or
// under node_modules on the way there is refused.
for (const [mode, link, specifier] of [
	["outside-root", "outside", "../outside/value.js"],
	["node_modules", "script/node_modules/shim", "./node_modules/shim/value.js"],
] as const) test(`a relative specifier traversing a symlink fails identity (${mode})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		`import { test, expect } from "bun:test"; import { value } from "${specifier}"; test("linked path", () => { expect(value).toBe(42); });\n`);
	try {
		mkdirSync(dirname(join(f.root, link)), { recursive: true });
		symlinkSync(join(f.root, "script/pkg/dist"), join(f.root, link));
		await collectRefused(f, "script/subject.test.ts", `import "${specifier}" traverses a symlink at ${link}`);
	} finally { f.cleanup(); }
}, 120_000);

// A root manifest's `imports` map routes `#` specifiers; frozen, it pins the
// emission it names, and unfrozen it is refused before any proof is weighed.
for (const frozen of [true, false]) test(`a root imports map routes a # specifier only when frozen (${frozen})`, async () => {
	const f = emittedWorkspace("export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose } from "#emitted"; test("imports map", () => { expect(choose(true)).toBe(42); });\n');
	try {
		f.put("package.json", '{"name":"fixture-root","type":"module","imports":{"#emitted":"./script/pkg/dist/index.js"}}');
		if (frozen) {
			const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
			inventory.configurations = [...list(inventory.configurations), { path: "package.json", sha256: sha256(readFileSync(join(f.root, "package.json"))) }];
			refreeze(f, "inventory", inventory);
			expect(await collectedEmissions(f, ["script/pkg/dist/index.js", "script/pkg/dist/value.js"])).toBe(1);
			expect(await verifiedAfterErasure(f)).toContain("emitted module imported by script/subject.test.ts has no emission proof");
		} else await collectRefused(f, "script/subject.test.ts", 'package scope manifest package.json routing "#emitted" is not frozen');
	} finally { f.cleanup(); }
}, 120_000);

test("verified workspace emit preserves package resolution and exact original counters", async () => {
	const f = emittedWorkspace();
	try {
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.result.errors).toBeUndefined();
		expect(run.exit).toBe(1);
		expect(run.result.complete).toBe(true);
		const { exact, file, counts, hits } = originalCounters(f);
		expect(hits(3)).toEqual([1, 1]);
		expect(hits(4)).toEqual([0]);
		expect(hits(7)).toEqual([0]);
		expect(Object.entries(file.fnMap).filter(([, fn]) => fn.name === "dormant").map(([id]) => counts.f[id])).toEqual([0]);
		expect([...exact.totals.keys()].some((path) => path.includes("/dist/"))).toBe(false);
	} finally { f.cleanup(); }
}, 120_000);

for (const defect of ["stale-source", "stale-build", "javascript", "map", "escaping-map", "map-file", "map-source", "configuration", "unmapped-generated"]) {
	test(`workspace emit rejects ${defect} without generated ownership`, async () => {
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
					refreeze(f, "inventory", inventory);
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
			const run = await f.run(["--collect"]);
			expect(run.exit).toBe(2);
			expect(run.result.complete).toBe(false);
			expect(list(run.result.errors)).toHaveLength(1);
		} finally { f.cleanup(); }
	}, 120_000);
}

test("workspace emit cannot silently ignore declared project references", async () => {
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
		refreeze(f, "inventory", inventory);
		const run = await f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain("emitted_config");
	} finally { f.cleanup(); }
}, 120_000);

test("workspace emit rejects bytes that only decode to the compiler output", async () => {
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
		const run = await f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain("tamper");
	} finally { f.cleanup(); }
}, 120_000);

for (const [name, source] of [
	["const enum", "const enum Answer { Value = 42 }\nexport const value = Answer.Value;\n"],
	["downlevel class fields", "class Answer { value = 42; }\nexport const value = new Answer().value;\n"],
]) test(`workspace emit fails closed for unsupported ${name} maps`, async () => {
	if (!source) throw new Error("missing lowering fixture");
	const f = emittedWorkspace(source);
	try {
		const native = Bun.spawnSync([process.execPath, "test", "./script/subject.test.ts"], { cwd: f.root, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		expect(native.exitCode).toBe(0);
		const run = await f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(str(obj(list(run.result.errors)[0]).message)).toContain("source_map");
	} finally { f.cleanup(); }
}, 120_000);

test("write-result stores the complete verdict and prints a hashed pointer", async () => {
	const f = fixture();
	try {
		const coverage = join(f.root, "coverage.json"), verdict = join(f.root, "result.json");
		const run = await f.run(["--collect", "--write-coverage", coverage, "--write-result", verdict]);
		const stored = obj(decode(readFileSync(verdict, "utf8")));
		expect(stored.exitCode).toBe(run.exit);
		expect(Object.keys(run.result).sort()).toEqual(["aggregate", "complete", "exitCode", "result", "resultSha256"]);
		expect(run.result.result).toBe(verdict);
		expect(run.result.resultSha256).toBe(sha256(readFileSync(verdict)));
		expect(run.result.complete).toBe(true);
		expect(run.result.aggregate).toEqual(stored.aggregate);
		expect(list(stored.measurements).length).toBeGreaterThan(0);
		expect((await f.run(["--collect", "--write-coverage", join(f.root, "again.json"), "--write-result", verdict])).exit).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("workspace emit receipt binds compiler, artifact, original and map identities", async () => {
	const f = emittedWorkspace();
	try {
		const path = join(f.root, "coverage.json");
		expect((await f.run(["--collect", "--write-coverage", path])).exit).toBe(1);
		const original = obj(decode(readFileSync(path, "utf8")));
		for (const field of ["source", "project", "sha256", "mapSha256", "mapHash", "observationSha256", "observationCount", "syntheticCount"]) {
			const receipt = structuredClone(original);
			const process = list(receipt.processes).map(obj).find((process) => process.emitted !== undefined);
			if (!process) throw new Error("missing emitted provenance");
			const proof = obj(list(process.emitted)[0]);
			proof[field] = field.endsWith("256") || field === "mapHash" ? "0".repeat(64) : "script/wrong.ts";
			f.put("coverage.json", JSON.stringify(receipt));
			const verified = await f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))]);
			expect(verified.exit).toBe(2);
			expect(obj(list(verified.result.errors)[0]).code).toBe("identity");
		}
		// Emission provenance is mandatory for every JavaScript process: deleting
		// the proofs (with a fresh digest) is rejected, not read as direct source loads.
		// Erasing the transfer record together with the proofs is caught by the
		// frozen tree: the loaded test statically imports the compiled package.
		for (const [tampered, message] of [
			[(process: ReturnType<typeof obj>) => { delete process.emitted; }, "object keys differ"],
			[(process: ReturnType<typeof obj>) => { process.emitted = []; }, "emission proofs do not match the transferred sources"],
			[(process: ReturnType<typeof obj>) => { process.emitted = []; process.transferred = []; }, "emitted module imported by script/subject.test.ts has no emission proof"],
		] as const) {
			const receipt = structuredClone(original);
			const process = list(receipt.processes).map(obj).find((process) => list(process.emitted ?? []).length > 0);
			if (!process) throw new Error("missing emitted provenance");
			tampered(process);
			f.put("coverage.json", JSON.stringify(receipt));
			const verified = await f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))]);
			expect(verified.exit).toBe(2);
			expect(str(obj(list(verified.result.errors)[0]).message)).toContain(message);
		}
		f.put("coverage.json", JSON.stringify(original));
		f.put("script/pkg/dist/value.js", readFileSync(join(f.root, "script/pkg/dist/value.js"), "utf8").replace("42", "43"));
		expect((await f.run(["--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))])).exit).toBe(2);
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

test("real Bun tests fully cover every dimension, including test callbacks, and old owner consumes the receipt", async () => {
	const f = await collected();
	try {
		expect(f.exit).toBe(0);
		const metrics = obj(f.result.aggregate);
		for (const metric of Object.values(metrics)) {
			const m = obj(metric);
			expect(m.covered).toBe(m.total);
		}
		expect(list(f.result.measurements).some((m) => obj(m).category === "test")).toBe(true);
		const path = join(f.root, "coverage.json");
		const child = Bun.spawnSync(
			[process.execPath, owner, ...f.args, "--coverage-input", path, "--coverage-sha256", sha256(readFileSync(path))],
			{ stdout: "pipe", stderr: "pipe", timeout: 120_000 },
		);
		expect(child.exitCode).toBe(0);
		expect(obj(decode(child.stdout.toString())).aggregate).toEqual(f.result.aggregate);
	} finally {
		f.cleanup();
	}
}, 120_000);

test("actual uncovered statement, branch, function and line remain separate findings", async () => {
	const f = await collected({
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

test("unimported nested tooling receives regenerated zero counters, never an empty-report exemption", async () => {
	const f = await collected({
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

test("TSX executable maps retain original identity under the automatic JSX runtime", async () => {
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
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		if (run.exit !== 0) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
		expect(list(run.result.measurements).some((m) => obj(m).path === "script/view.tsx")).toBe(true);
	} finally {
		f.cleanup();
	}
}, 120_000);

test("Bun synchronous and asynchronous child receipts supply genuine coverage", async () => {
	const sources = {
		"script/child.ts": "console.log(41 + 1);\n",
		"script/parent.ts":
			'const sync = Bun.spawnSync([process.execPath, "script/child.ts"], {stdout:"pipe"}); console.log(sync.stdout.toString()); const asyncChild = Bun.spawn([process.execPath, "script/child.ts"], {stdout:"ignore"}); await asyncChild.exited;\n',
	};
	const f = await collected(sources, [
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

test("missing input, stale source, altered inventory, incomplete inventory and unsupported syntax fail closed", async () => {
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
			const result = await f.run(["--collect"]);
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

test("real receipts reject tampered maps, missing counters/files/processes and noninteger counts", async () => {
	const f = await collected();
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
			const result = await f.run([
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

test("lost real child receipt cannot be credited as covered", async () => {
	const f = await collected(
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
		const result = await f.run([
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

test("real 99 of 100 statements fails without percentage rounding", async () => {
	const f = await collected(
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

test("caught unsupported subprocess cannot become clean coverage", async () => {
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
		const run = await f.run(["--collect"]);
		expect(run.exit).toBe(2);
		expect(run.result.complete).toBe(false);
		expect(JSON.stringify(run.result)).toContain("unregistered native executable");
	} finally {
		f.cleanup();
	}
}, 120_000);

test("type-only declarations are syntax-proven not-applicable, not missing-file credit", async () => {
	const f = await collected({
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

async function collectReceipt(f: ReturnType<typeof fixture>): Promise<{ [key: string]: Json }> {
	const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
	expect(run.exit).toBe(0);
	return obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
}
/** The root receipt and the worker receipt it parents, from a collection that observed exactly those two processes. */
function rootAndWorker(receipt: { [key: string]: Json }, missing: string): [{ [key: string]: Json }, { [key: string]: Json }] {
	const processes = list(receipt.processes).map(obj);
	expect(processes).toHaveLength(2);
	const root = processes.find((process) => str(process.parent) === "");
	const worker = processes.find((process) => str(process.parent) !== "");
	if (!root || !worker) throw new FixtureError(missing);
	expect(str(worker.parent)).toBe(str(root.id));
	return [root, worker];
}
/** Collect a fixture whose complete measurement still leaves statements
 * uncovered (exit 1), returning the process receipts it wrote. */
async function collectProcesses(f: ReturnType<typeof fixture>, environment: NodeJS.ProcessEnv = {}): Promise<{ [key: string]: Json }[]> {
	const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], environment);
	if (run.exit !== 1) throw new Error(JSON.stringify({ exit: run.exit, result: run.result, stderr: run.stderr }));
	expect(run.result.complete).toBe(true);
	return list(obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8"))).processes).map(obj);
}
/** Collect an entry that launches utilities found on the canonical system
 * PATH: they run natively, so the entry's own process is the only receipt. */
async function collectUtility(source: string): Promise<void> {
	const f = fixture({ "script/utility.ts": source }, cli("script/utility.ts"));
	try {
		expect(await collectProcesses(f, { PATH: "/usr/bin:/bin" })).toHaveLength(1);
	} finally { f.cleanup(); }
}
/** Plant an always-succeeding executable inside the frozen root; the returned PATH searches its directory first. */
function plantedPath(f: ReturnType<typeof fixture>, name: string): string {
	const fake = join(f.root, "fake-bin", name);
	mkdirSync(dirname(fake), { recursive: true });
	writeFileSync(fake, "#!/bin/sh\nexit 0\n");
	chmodSync(fake, 0o755);
	return `${dirname(fake)}:/usr/bin:/bin`;
}
/** Freeze a worker module that loads the shared emission into an emitted workspace's inventory. */
function freezeWorker(f: ReturnType<typeof fixture>): void {
	const path = "script/worker.ts";
	f.put(path, 'import { choose } from "@fixture/emitted"; export const ready = choose(false);\n');
	const bytes = readFileSync(join(f.root, path));
	const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
	list(inventory.files).push({ path, sha256: sha256(bytes), bytes: bytes.byteLength, category: "tooling", language: "typescript" });
	list(inventory.files).sort((a, b) => str(obj(a).path).localeCompare(str(obj(b).path)));
	refreeze(f, "inventory", inventory);
}
/** The exact counters of the emitted workspace's original barrel, with its statement hits by source line. */
function originalCounters(f: ReturnType<typeof fixture>) {
	const inventory = loadInventory(f.root, join(f.root, "inventory.json"));
	const prepared = inventory.files.map(prepare);
	const exact = loadCoverage(join(f.root, "coverage.json"), inventory, prepared, { root: f.root, contract: join(f.root, "contract.json"), inventory: join(f.root, "inventory.json"), plan: join(f.root, "plan.json") });
	const file = prepared.find((file) => file.path === "script/pkg/src/index.ts");
	if (!file) throw new Error("missing original map");
	const counts = statementCounters(file, exact);
	const hits = (line: number) => Object.entries(file.statementMap).filter(([, range]) => range.start.line === line).map(([id]) => counts.s[id]);
	return { exact, file, counts, hits };
}

function pythonProcess(receipt: { [key: string]: Json }): { [key: string]: Json } {
	return obj(list(receipt.processes).map(obj).find((p) => p.runtime === "python"));
}

test("native Node entry and Bun-to-Node processes preserve effects and original TS counters", async () => {
	const f = await collected({
		"script/child.ts": 'import {appendFileSync} from "node:fs"; appendFileSync("effect.txt","N"); console.log(42);',
		"script/parent.ts": 'import {spawnSync,spawn} from "node:child_process"; import assert from "node:assert/strict"; const sync=spawnSync("node",["script/child.ts"],{encoding:"utf8"}); assert.equal(sync.status,0); assert.equal(sync.stdout.trim(),"42"); const child=spawn("node",["script/child.ts"]); await new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{assert.equal(code,0);assert.equal(signal,null);resolve();});});',
	}, cli("script/parent.ts"));
	try {
		expect(f.exit).toBe(0);
		expect(readFileSync(join(f.root, "effect.txt"), "utf8")).toBe("NN");
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		expect(list(receipt.processes).filter((r) => obj(r).runtime === "node")).toHaveLength(2);
	} finally { f.cleanup(); }
	const direct = await collected({ "script/main.ts": "const value: number=42; console.log(value);" }, cli("script/main.ts", "node"));
	try { expect(direct.exit).toBe(0); } finally { direct.cleanup(); }
}, 120_000);

test("Python statements, functions, static arcs, short circuits and lines are real independent counters", async () => {
	const source = 'def select(value):\n    if value:\n        return 1\n    return 0\nassert select(True) == 1\nassert select(False) == 0\ndef choose(value):\n    return value and 7\nx = choose(True)\ny = choose(False)\nassert x == 7\nassert y is False\nopen("effect.txt", "w").write("PY")\n';
	const f = await collected({ "script/main.py": source }, cli("script/main.py", "python"));
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
			expect((await verifyChanged(f, changed)).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test("the Python collector map joins the metrics analyzer map for methods, nested defs, lambdas and non-executable statements", async () => {
	// The docstring, __future__ import, type alias and global declaration are the
	// statement classes where a second map owner previously disagreed with the collector.
	const source = '"""module docs"""\nfrom __future__ import annotations\ntype Scale = int\nTOTAL = 0\nclass Box:\n    def __init__(self, value):\n        self.value = value\n\n    def scale(self, factor):\n        global TOTAL\n        def inner(v):\n            return v * factor\n        TOTAL += 1\n        return inner(self.value)\n\n\ndouble = lambda v: v * 2\nassert Box(3).scale(2) == 6\nassert double(4) == 8\n';
	const f = await collected({ "script/main.py": source }, cli("script/main.py", "python"));
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

test("unexecuted Python is uncovered, not unsupported and not credited by a host string", async () => {
	const f = await collected({ "script/main.ts": "console.log(42);", "script/unloaded.py": "def missing():\n    return 1\n" }, cli("script/main.ts"));
	try { expect(f.exit).toBe(1); expect(findings(f.result).some((v) => v.path === "script/unloaded.py" && v.class === "functions")).toBe(true); }
	finally { f.cleanup(); }
}, 120_000);

test.each([
	["refusing", 'console.error("refused"); process.exit(1);', 1, null],
	["killed", 'process.kill(process.pid,"SIGKILL");', null, "SIGKILL"],
])("a %s child's flushed receipt is complete evidence; a missing child receipt is not", async (_, body, exitCode, signal) => {
	const f = await collected({ "script/main.ts": 'Bun.spawnSync([process.execPath,"script/child.ts"]);', "script/child.ts": body }, cli("script/main.ts"));
	try {
		expect(f.exit).toBe(0);
		const original = readFileSync(join(f.root, "coverage.json"), "utf8");
		const receipt = obj(decode(original));
		const processes = list(receipt.processes).map(obj);
		const child = obj(processes.find((p) => p.parent !== ""));
		expect(child.exitCode).toBe(exitCode);
		expect(child.signal).toBe(signal);
		expect(Object.values(obj(obj(obj(child.coverage)["script/child.ts"]).s))).toEqual(body.split(";").filter(Boolean).map(() => 1));
		expect((await verifyChanged(f, receipt)).exit).toBe(0);
		const partial = obj(decode(original));
		partial.processes = list(partial.processes).filter((p) => obj(p).parent === "");
		expect((await verifyChanged(f, partial)).exit).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("nonowned ESM and CommonJS dependencies execute natively without coverage credit", async () => {
	const f = fixture({ "script/main.ts": 'import assert from "node:assert/strict"; import {value} from "review-dependency"; import common from "review-common"; assert.equal(value + common,42);' }, cli("script/main.ts"));
	try {
		f.put("node_modules/review-dependency/package.json", '{"type":"module","exports":"./index.js"}');
		f.put("node_modules/review-dependency/index.js", 'export const value=20;');
		f.put("node_modules/review-common/package.json", '{"main":"index.cjs"}');
		f.put("node_modules/review-common/index.cjs", 'module.exports=22;');
		const native = Bun.spawnSync([process.execPath, "script/main.ts"], { cwd: f.root });
		expect(native.exitCode).toBe(0);
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		expect(obj(list(receipt.processes)[0]).loaded).toEqual(["script/main.ts"]);
	} finally { f.cleanup(); }
}, 120_000);

test("missing owned imports still fail at the loader boundary", async () => {
	const f = fixture({ "script/main.ts": 'import {writeFileSync} from "node:fs"; writeFileSync("script/late.ts","export const value=42;"); await import("./late.ts");' }, cli("script/main.ts"));
	try { expect((await f.run(["--collect"])).exit).toBe(2); }
	finally { f.cleanup(); }
}, 120_000);

test("Bun child preloads retain native import order and instrument the child context", async () => {
	const f = fixture({
		"script/main.ts": 'import assert from "node:assert/strict"; const child=Bun.spawnSync([process.execPath,"--preload","./script/preload.ts","./script/child.ts"],{stdout:"pipe"}); assert.equal(child.exitCode,0); assert.equal(child.stdout.toString(),"IMPORT\\nPRELOAD\\nCHILD\\n");',
		"script/preload.ts": 'import "./imported"; console.log("PRELOAD");',
		"script/imported.ts": 'console.log("IMPORT");',
		"script/child.ts": 'console.log("CHILD");',
	}, cli("script/main.ts"));
	try {
		expect(Bun.spawnSync([process.execPath, "script/main.ts"], { cwd: f.root }).exitCode).toBe(0);
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const child = list(receipt.processes).map(obj).find((p) => p.parent !== "");
		expect(list(obj(child).loaded).sort()).toEqual(["script/child.ts", "script/imported.ts", "script/preload.ts"]);
		expect(obj(child).entry).toBe("script/child.ts");
	} finally { f.cleanup(); }
}, 120_000);

test("Python abrupt zero exit cannot substitute persistent counters for normal flush", async () => {
	const f = await collected({ "script/main.py": "import os\nos._exit(0)\n" }, cli("script/main.py", "python"));
	try { expect(f.exit).toBe(2); expect(f.result.complete).toBe(false); }
	finally { f.cleanup(); }
}, 120_000);

test("normal Python flush provenance survives collection and rejects receipt corruption", async () => {
	const f = await collected({ "script/main.py": "print(42)\n" }, cli("script/main.py", "python"));
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
			expect((await verifyChanged(f, changed)).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test.each(["empty-arcs", "empty-translated", "both-empty", "impossible", "entry-removed", "added-impossible", "line-counter"])("real Python trace rejects semantic mutation %s after outer rehash", async (defect) => {
	const f = await collected({ "script/main.py": "print(42)\n" }, cli("script/main.py", "python"));
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
		const verified = await verifyChanged(f, receipt);
		expect(verified.exit).toBe(2);
		expect(verified.result.complete).toBe(false);
	} finally { f.cleanup(); }
}, 120_000);

test("unexecuted Python files retain legitimate empty traces and uncovered counters", async () => {
	const f = await collected({ "script/main.py": "print(42)\n", "script/unexecuted.py": "print(7)\n" }, cli("script/main.py", "python"));
	try {
		expect(f.exit).toBe(1);
		expect(f.result.complete).toBe(true);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const process = obj(list(receipt.processes)[0]);
		expect(obj(obj(process.trace).files)["script/unexecuted.py"]).toEqual({ arcs: [], translatedArcs: [] });
		expect(process.loaded).toEqual(["script/main.py"]);
		expect((await verifyChanged(f, receipt)).exit).toBe(1);
	} finally { f.cleanup(); }
}, 120_000);

test("the frozen Python runner source is never credited with its own driver frames", async () => {
	const driver = readFileSync(join(import.meta.dir, "quality-coverage/python.py"), "utf8");
	const f = fixture({ "script/main.py": "print(42)\n", "script/quality-coverage/python.py": driver }, cli("script/main.py", "python"));
	try {
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], { D945_ASSET_DIRECTORY: join(f.root, "script/quality-coverage") });
		expect(run.exit).toBe(1);
		expect(run.result.complete).toBe(true);
		const receipt = obj(decode(readFileSync(join(f.root, "coverage.json"), "utf8")));
		const process = obj(list(receipt.processes)[0]);
		expect(process.loaded).toEqual(["script/main.py"]);
		expect(obj(obj(process.trace).files)["script/quality-coverage/python.py"]).toEqual({ arcs: [], translatedArcs: [] });
	} finally { f.cleanup(); }
}, 120_000);

test("a dependency program under node_modules runs natively instead of needing a frozen entry", async () => {
	const f = fixture({
		"script/main.ts": 'import assert from "node:assert/strict"; const child = Bun.spawnSync([process.execPath, "node_modules/dep/bin/cli.js"], { stdout: "pipe" }); assert.equal(child.exitCode, 0); assert.equal(child.stdout.toString(), "dep\\n");',
	}, cli("script/main.ts"));
	f.put("node_modules/dep/bin/cli.js", 'console.log("dep");\n');
	try {
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		expect(run.result.complete).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test("a failing checker CLI under an outer collection leaves no failure file for the inherited process identity", async () => {
	const f = fixture();
	const outer = realpathSync(mkdtempSync(join(tmpdir(), "d945-outer-")));
	try {
		const run = await f.run(["--plan-sha256", "0".repeat(64)], { D945_DIRECTORY: outer, D945_PROCESS: "outer-1" });
		expect(run.exit).toBe(2);
		expect(existsSync(join(outer, "outer-1.failure.json"))).toBe(false);
	} finally { f.cleanup(); rmSync(outer, { recursive: true, force: true }); }
}, 120_000);

test("an unselected collection ignores an inherited outer D945_SOURCE_ROOT for its Python launches", async () => {
	const f = fixture({ "script/main.py": "print(42)\n" }, cli("script/main.py", "python"));
	try {
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], { D945_SOURCE_ROOT: join(f.root, "elsewhere") });
		expect(run.exit).toBe(0);
		expect(run.result.complete).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test("Python static branch counters must agree with the flushed raw arc set", async () => {
	const f = await collected({ "script/main.py": "def choose(x):\n    if x:\n        return 1\n    return 0\nchoose(True)\nchoose(False)\n" }, cli("script/main.py", "python"));
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
			expect((await verifyChanged(f, receipt)).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test("only a signal-terminated Python child may omit its normal trace", async () => {
	const f = fixture({ "script/main.ts": 'Bun.spawnSync([process.env.D945_PYTHON,"script/child.py"]);', "script/child.py": 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n' }, cli("script/main.ts"));
	try {
		const receipt = await collectReceipt(f);
		const child = pythonProcess(receipt);
		expect(child.trace).toBe(null);
		expect(child.signal).toBe("SIGKILL");
		expect((await verifyChanged(f, receipt)).exit).toBe(0);
		for (const exitCode of [0, 1]) {
			const normal = obj(decode(JSON.stringify(receipt)));
			const process = pythonProcess(normal);
			process.signal = null; process.exitCode = exitCode;
			expect((await verifyChanged(f, normal)).exit).toBe(2);
		}
	} finally { f.cleanup(); }
}, 120_000);

test("a frozen Python entry launched in isolated mode is credited and stays isolated", async () => {
	const f = fixture({ "script/main.ts": 'import assert from "node:assert/strict"; const child=Bun.spawnSync([process.env.D945_PYTHON,"-I","script/child.py"],{stdout:"pipe",stderr:"pipe"}); assert.equal(child.exitCode,0,child.stderr.toString()); assert.equal(child.stdout.toString(),"1\\n");', "script/child.py": 'import sys\nprint(sys.flags.isolated)\n' }, cli("script/main.ts"));
	try {
		const child = pythonProcess(await collectReceipt(f));
		expect(child.entry).toBe("script/child.py");
		expect(child.exitCode).toBe(0);
		expect(obj(child.trace).flushed).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test("embedded Python raw Unicode retains exact source identity through Bun loading", async () => {
	const source = "# \u2014\nprint(42)\n";
	const f = fixture({ "script/main.ts": `import assert from "node:assert/strict"; const PYTHON_DRIVER=String.raw\`${source}\`; const child=Bun.spawnSync([process.env.D945_PYTHON,"-u","-c",PYTHON_DRIVER],{stdout:"pipe"}); assert.equal(child.exitCode,0); assert.equal(child.stdout.toString(),"42\\n");` }, cli("script/main.ts"));
	try {
		const inventory = obj(decode(readFileSync(join(f.root, "inventory.json"), "utf8")));
		inventory.embedded = [{ path: "script/main.ts#PYTHON_DRIVER", sha256: sha256(source), bytes: Buffer.byteLength(source), category: "production", language: "python" }];
		refreeze(f, "inventory", inventory);
		const child = pythonProcess(await collectReceipt(f));
		expect(child.entry).toBe("script/main.ts#PYTHON_DRIVER");
		expect(obj(child.trace).flushed).toBe(true);
	} finally { f.cleanup(); }
}, 120_000);

test.each([1, 2])("v%i retains all-test and operational CLI omission rejection", async (version) => {
	for (const omitted of ["test", "cli"]) {
		const f = fixture({ ...fixtures, "script/entry.ts": "if (import.meta.main) console.log(1);\n" });
		try {
			const commands = omitted === "test" ? cli("script/entry.ts") : defaultPlan;
			refreeze(f, "plan", { version, commands: decode(JSON.stringify(commands)) });
			const result = await f.run(["--collect"]);
			expect(result.exit).toBe(2);
			expect(result.result.complete).toBe(false);
			expect(obj(list(result.result.errors)[0]).code).toBe("plan");
			expect(obj(list(result.result.errors)[0]).path).toBe(omitted === "test" ? "script/subject.test.ts" : "script/entry.ts");
		} finally { f.cleanup(); }
	}
});

test("v3 executes selected roots in two workspaces and retains exact uncovered inventory", async () => {
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
		const result = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
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
			expect((await verifyChanged(f, changed)).exit).toBe(2);
		}
		symlinkSync(join(f.root, "script/one"), join(f.root, "alias"));
		for (const cwd of ["../outside", "/tmp", "script/one/..", "script//one", "script/missing", "script/shared.ts", "alias", "script/two"]) {
			refreeze(f, "plan", { ...plan, commands: plan.commands.map((command, index) => index === 0 ? { ...command, cwd } : command) });
			expect((await f.run(["--collect"])).exit).toBe(2);
		}
		for (const run of [null, { id: "", selectionHash: sha256("selection") }, { id: "run", selectionHash: "bad" }]) {
			refreeze(f, "plan", { ...plan, run });
			expect((await f.run(["--collect"])).exit).toBe(2);
		}
		refreeze(f, "plan", { ...plan, run: { ...plan.run, id: "stale" } });
		expect((await verifyChanged(f, receipt)).exit).toBe(2);
	} finally { f.cleanup(); }
}, 120_000);

test("a missing test entry and update mode are analysis errors", async () => {
	const f = fixture(fixtures, [
		{ id: "only-cli", kind: "cli", paths: ["script/subject.ts"], args: [], expectedExitCode: 0 },
	]);
	try {
		expect((await f.run(["--collect"])).exit).toBe(2);
		expect((await f.run(["--update"])).exit).toBe(2);
	} finally {
		f.cleanup();
	}
});


test("metrics consumes the actual verified collector receipt without fabricated coverage", async () => {
	const f = await collected();
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

test("decode rejects invalid escapes and leading zeros while accepting unicode escapes", async () => {
	expect(decode('"a\\u0041b"')).toBe("aAb");
	expect(decode('[1, -0.5, 2e3, "x\\n"]')).toEqual([1, -0.5, 2000, "x\n"]);
	for (const text of ['"\\q"', "01", '"\\u12"', '"unterminated', '"raw\ttab"', "[1,]", '{"a":1,}', "1 2"]) {
		const thrown = await Promise.resolve(text).then(decode).then((): Json => null, (error: Json) => error);
		expect(obj(thrown).code, text).toBe("schema");
	}
});

test("frozen source screening rejects dynamic code, unfrozen worker targets, Node process hooks and shell templates", async () => {
	const path = "script/screened.ts";
	const rejected = async (source: string) => obj(await thrown(() => syntax(source, path)));
	const unsupported = (code: string, message: string) => ({ code, path, message });
	syntax('import { readFileSync } from "node:fs"; const fs = require("node:fs"); new Worker(new URL("./w.ts", import.meta.url)); await import("./x"); export const n = [readFileSync, fs].length;', path);
	for (const source of ["eval(code);", "Function(body);", "require(name);"])
		expect(await rejected(source), source).toEqual(unsupported("unsupported_syntax", "dynamic code or module loading"));
	for (const source of ['eval("1");', 'Function("return 1");', 'new Function("return 1");'])
		expect(await rejected(source), source).toEqual(unsupported("unsupported_syntax", "dynamic executable source"));
	expect(await rejected('new Worker("./w.ts");')).toEqual(unsupported("unsupported_process", "worker target is not a frozen file URL"));
	for (const source of ['import vm from "node:vm";', 'export * from "cluster";', 'await import("node:cluster");', 'require("vm");'])
		expect(await rejected(source), source).toEqual(unsupported("unsupported_process", "Node process/context hooks are not supported by the Bun collector"));
	for (const source of ["await $`ls`;", "await Bun.$`ls`;"])
		expect(await rejected(source), source).toEqual(unsupported("unsupported_process", "shell process graph is not observable through Bun.spawn"));
	expect(await rejected("//# sourceMappingURL=screened.js.map\n")).toEqual(unsupported("unsupported_syntax", "coverage directives and preexisting maps are forbidden"));
});

/** A prepared snapshot of an empty file at `path`, as the collector's inventory records it. */
function preparedSnapshot(path: string, language = "typescript"): { [key: string]: Json } {
	const counters = { path, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} };
	return {
		entry: { path, sha256: sha256(""), bytes: 0, category: "tooling", language },
		code: "",
		mapHash: sha256("map"),
		coverage: counters,
		mapped: counters,
		...(language === "python" ? { python: { source: `# ${path}\n`, lines: [], arcs: null } } : {}),
	};
}

test("a launch names its frozen entry after recognized interpreter options or runs natively", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "d945-launch-")));
	try {
		const a = preparedFrom(preparedSnapshot("script/a.ts")), b = preparedFrom(preparedSnapshot("script/b.py", "python"));
		const data = { options: { root }, files: [a, b] };
		const launch = (argv: string[], runtime = "bun", cwd = root) => launchEntry(data, argv, runtime, `${runtime}-binary`, cwd);
		const refused = async (argv: string[], runtime = "bun") => obj(await thrown(() => launch(argv, runtime)));
		// A frozen program, with its options and Bun's test subcommand recognized once.
		expect(launch(["script/a.ts", "x"])).toEqual({ entry: a, args: ["x"], interpreter: [] });
		expect(launch(["--no-warnings", "test", "--timeout", "5000", "./script/a.ts"])).toEqual({ entry: a, args: [], interpreter: [] });
		expect(launch(["-I", "script/b.py", "y"], "python")).toEqual({ entry: b, args: ["y"], interpreter: ["-I"] });
		expect(launch(["-u", "-c", `# script/b.py\n`, "z"], "python")).toEqual({ entry: b, args: ["z"], interpreter: [] });
		// Nothing to credit: an option-only probe, inline text that is not a frozen source,
		// a program outside the root and a dependency's own program all run natively.
		expect(launch(["--version"])).toEqual({ external: "bun-binary" });
		expect(launch(["-e", "1"])).toEqual({ external: "bun-binary" });
		expect(launch(["-I", "-c", "print(7)"], "python")).toEqual({ external: "python-binary" });
		expect(launch([import.meta.path])).toEqual({ external: import.meta.path });
		mkdirSync(join(root, "node_modules/dep"), { recursive: true });
		writeFileSync(join(root, "node_modules/dep/cli.js"), "");
		expect(launch(["node_modules/dep/cli.js"])).toEqual({ external: join(root, "node_modules/dep/cli.js") });
		// Inside the root only frozen inventory launches, in its own language, with registered options.
		expect(await refused(["script/missing.ts"])).toEqual({ code: "unsupported_process", path: "bun-binary", message: "entry/source is absent from frozen language inventory" });
		expect(await refused(["script/b.py"])).toEqual({ code: "unsupported_process", path: "bun-binary", message: "entry/source is absent from frozen language inventory" });
		expect(await refused(["--smol", "script/a.ts"])).toEqual({ code: "unsupported_process", path: "bun-binary", message: "unregistered interpreter option --smol" });
		expect(await refused(["-I", "-c", `# script/b.py\n`], "python")).toEqual({ code: "unsupported_process", path: "python-binary", message: "unrecognized Python interpreter option" });
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a prepared snapshot decodes its unmapped counters by kind and rejects any other kind", async () => {
	const snapshot = preparedSnapshot("script/a.ts");
	const counter = (kind: string) => ({ kind, id: "3", start: { line: 1, column: 0 }, end: { line: 1, column: 4 } });
	expect(preparedFrom(snapshot).unmapped).toBeUndefined();
	expect(preparedFrom({ ...snapshot, unmapped: ["statement", "function", "branch"].map(counter) }).unmapped).toEqual([
		{ kind: "statement", id: "3", start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
		{ kind: "function", id: "3", start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
		{ kind: "branch", id: "3", start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
	]);
	expect(await thrown(() => preparedFrom({ ...snapshot, unmapped: [counter("line")] }))).toEqual({ code: "schema", path: "", message: "invalid enum" });
	expect(await thrown(() => preparedFrom({ ...snapshot, unmapped: [{ ...counter("branch"), line: 1 }] }))).toEqual({ code: "schema", path: "", message: "object keys differ" });
});

test("shared emission cache serves a second process the same verified identity", async () => {
	const f = emittedWorkspace(
		"export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose } from "@fixture/emitted"; import { Worker } from "node:worker_threads"; test("emitted entry", async () => { expect(choose(true)).toBe(42); const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); await new Promise<void>((resolve) => worker.once("exit", () => resolve())); });\n',
	);
	try {
		freezeWorker(f);
		const processes = await collectProcesses(f);
		expect(processes).toHaveLength(2);
		for (const process of processes) expect(list(process.loaded).map(str)).toContain("script/pkg/src/index.ts");
	} finally { f.cleanup(); }
}, 120_000);

test("concurrent cold workers each receive the shared emission without corrupting the cache", async () => {
	// The cache write is `<cache>.<pid>.<thread>.<uuid>.tmp` then rename: sibling
	// workers share one pid, so a pid-only temporary produced ENOENT at rename
	// when two cold loads overlapped. Four cold workers exercise that path; the
	// overlap itself is not forced, so this is execution coverage, not a race oracle.
	const f = emittedWorkspace(
		"export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { Worker } from "node:worker_threads"; test("cold workers", async () => { const workers = Array.from({ length: 4 }, () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })); const codes = await Promise.all(workers.map((worker) => new Promise<number>((resolve) => worker.once("exit", resolve)))); expect(codes).toEqual([0, 0, 0, 0]); const { choose } = await import("@fixture/emitted"); expect(choose(true)).toBe(42); });\n',
	);
	try {
		freezeWorker(f);
		const processes = await collectProcesses(f);
		expect(processes).toHaveLength(5);
		for (const process of processes) expect(list(process.emitted).map((row) => str(obj(row).path)).sort()).toEqual(["script/pkg/dist/index.js", "script/pkg/dist/value.js"]);
	} finally { f.cleanup(); }
}, 120_000);

test("an emission identical to the original transpilation still transfers after the original loaded", async () => {
	// The 8b545e3b identity law failed on CI for protocol barrels: the original
	// evaluated first, then a later dynamic import loaded the tsc emission, whose
	// instrumented hash equals the original's, so Istanbul's `coverage[path].hash
	// !== hash` guard kept the original instance and the emitted counters never
	// reached the setter that records the transfer.
	const f = emittedWorkspace(
		"export const value = 42;\n",
		'import { test, expect } from "bun:test"; import { choose as original } from "./pkg/src/index.ts"; const { choose } = await import("@fixture/emitted"); test("both instances", () => { expect(original(true)).toBe(42); expect(choose(false)).toBe(99); });\n',
	);
	try {
		const [process] = await collectProcesses(f);
		if (!process) throw new Error("missing process receipt");
		const emitted = list(process.emitted).map((row) => str(obj(row).source));
		expect(emitted).toEqual(["script/pkg/src/index.ts", "script/pkg/src/value.ts"]);
		expect(list(process.transferred).map(str).sort()).toEqual(emitted);
		const { hits } = originalCounters(f);
		expect(hits(3)).toEqual([2, 1]);
		expect(hits(4)).toEqual([1]);
	} finally { f.cleanup(); }
}, 120_000);

test("exact collector runs an inline runtime evaluation as an external utility", async () => {
	await collectUtility('const run = Bun.spawnSync([process.execPath, "-e", "process.stdout.write(\'ok\')"], { stdout: "pipe", stderr: "pipe" }); if (run.stdout.toString() !== "ok") process.exit(7);\n');
}, 120_000);

test("exact collector admits a receipt-less executable outside the frozen root and refuses one inside", async () => {
	const source = 'const run = Bun.spawnSync(["fixture-tool", "print"], { stdout: "pipe", stderr: "pipe" }); if (run.stdout.toString().trim() !== "fixture-tool print") process.exit(7);\n';
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "d945-outside-")));
	const f = fixture({ "script/utility.ts": source }, cli("script/utility.ts"));
	try {
		for (const directory of [outside, join(f.root, "fake-bin")]) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "fixture-tool"), '#!/bin/sh\necho "fixture-tool $@"\n');
			chmodSync(join(directory, "fixture-tool"), 0o755);
		}
		const admitted = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], { PATH: `${outside}:/usr/bin:/bin` });
		if (admitted.exit !== 1) throw new Error(JSON.stringify({ exit: admitted.exit, result: admitted.result, stderr: admitted.stderr }));
		expect(admitted.result.complete).toBe(true);
		const refused = await f.run(["--collect"], { PATH: `${join(f.root, "fake-bin")}:/usr/bin:/bin` });
		expect(refused.exit).toBe(2);
		expect(JSON.stringify(refused.result)).toContain("unregistered native executable");
		// A name that resolves nowhere is the operating system's refusal, observed by the caller.
		const missing = await f.run(["--collect"], { PATH: "/usr/bin:/bin" });
		expect(missing.exit).toBe(2);
		expect(JSON.stringify(missing.result)).toContain("ENOENT");
		expect(JSON.stringify(missing.result)).not.toContain("cannot be resolved");
	} finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }); }
}, 120_000);

test("instrumented child processes report the command the caller asked for", async () => {
	const f = fixture({ "script/utility.ts": 'import { spawn } from "node:child_process"; const child = spawn("tail", ["-n", "1", "/dev/null"]); if (child.spawnfile !== "tail" || JSON.stringify(child.spawnargs) !== JSON.stringify(["tail", "-n", "1", "/dev/null"])) process.exit(7); await new Promise((resolve) => child.once("exit", resolve));\n' }, cli("script/utility.ts"));
	try {
		const run = await f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")], { PATH: "/usr/bin:/bin" });
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
