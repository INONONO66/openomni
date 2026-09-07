import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { coverageForMetrics, decode, exactMetric, sha256 } from "./check-quality-coverage";
import { run as metrics } from "./check-quality-metrics";

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
	function run(extra: string[] = [], entry = checker) {
		const child = Bun.spawnSync([process.execPath, entry, ...args, ...extra], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 120_000,
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
function findings(result: { [key: string]: Json }): { [key: string]: Json }[] {
	return list(result.findings).map(obj);
}

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

test("TSX executable maps retain original identity", () => {
	const f = collected({
		...fixtures,
		"script/subject.ts":
			'import { view } from "./view"; export function select(value: boolean) { view(); if(value) return 1; return 0; }',
		"script/view.tsx":
			"const React = { createElement(tag: string, props: null, child: number) { return {tag,props,child}; } }; export function view(){ return <div>{1}</div>; }",
	});
	try {
		expect(f.exit).toBe(0);
		expect(list(f.result.measurements).some((m) => obj(m).path === "script/view.tsx")).toBe(true);
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

test("killed real child and caught unsupported subprocess cannot become clean coverage", () => {
	for (const child of [
		'process.kill(process.pid, "SIGKILL");',
		'try { Bun.spawnSync(["/bin/echo", "external"]); } catch {}',
	]) {
		const f = collected(
			{
				"script/child.ts": child,
				"script/parent.ts": 'Bun.spawnSync([process.execPath,"script/child.ts"]);',
			},
			[{ id: "parent", kind: "cli", paths: ["script/parent.ts"], args: [], expectedExitCode: 0 }],
		);
		try {
			expect(f.exit).toBe(2);
			expect(f.result.complete).toBe(false);
		} finally {
			f.cleanup();
		}
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

test("unexecuted Python is uncovered, not unsupported and not credited by a host string", () => {
	const f = collected({ "script/main.ts": "console.log(42);", "script/unloaded.py": "def missing():\n    return 1\n" }, cli("script/main.ts"));
	try { expect(f.exit).toBe(1); expect(findings(f.result).some((v) => v.path === "script/unloaded.py" && v.class === "functions")).toBe(true); }
	finally { f.cleanup(); }
}, 120_000);

test("approved native killed boundary keeps counters and requires exact signal, checkpoint and count", () => {
	const f = fixture({ "script/main.ts": 'Bun.spawnSync([process.execPath,"script/child.ts"]);', "script/child.ts": 'process.kill(process.pid,"SIGKILL");' }, cli("script/main.ts"));
	const fault: Json = { id: "kill", command: "cli", entry: "script/child.ts", args: [], exitCode: null, signal: "SIGKILL", occurrences: 1, checkpoint: { path: "script/child.ts", statement: "0", minimumHits: 1 } };
	try {
		refreeze(f, "plan", { version: 2, commands: decode(JSON.stringify(cli("script/main.ts"))), faults: [fault] });
		const run = f.run(["--collect", "--write-coverage", join(f.root, "coverage.json")]);
		expect(run.exit).toBe(0);
		const original = readFileSync(join(f.root, "coverage.json"), "utf8");
		const receipt = obj(decode(original));
		const child = list(receipt.processes).map(obj).find((p) => p.parent !== "");
		expect(obj(child).exitCode).toBe(null);
		expect(obj(child).signal).toBe("SIGKILL");
		for (const defect of ["signal", "checkpoint", "partial"]) {
			const changed = obj(decode(original));
			const processes = list(changed.processes);
			const target = processes.map(obj).find((p) => p.parent !== "");
			if (defect === "signal") obj(target).signal = "SIGTERM";
			if (defect === "checkpoint") obj(obj(obj(target).coverage)["script/child.ts"]).s = { "0": 0 };
			if (defect === "partial") changed.processes = processes.filter((p) => obj(p).parent === "");
			expect(verifyChanged(f, changed).exit).toBe(2);
		}
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

test("only the exact approved Python kill can omit normal trace", () => {
	const f = fixture({ "script/main.ts": 'Bun.spawnSync([process.env.D945_PYTHON,"script/child.py"]);', "script/child.py": 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n' }, cli("script/main.ts"));
	try {
		refreeze(f, "plan", { version: 2, commands: decode(JSON.stringify(cli("script/main.ts"))), faults: [{ id: "kill", command: "cli", entry: "script/child.py", args: [], exitCode: null, signal: "SIGKILL", occurrences: 1, checkpoint: { path: "script/child.py", statement: "0", minimumHits: 1 } }] });
		const receipt = collectReceipt(f);
		const child = pythonProcess(receipt);
		expect(child.trace).toBe(null);
		expect(child.signal).toBe("SIGKILL");
		child.signal = null; child.exitCode = 0;
		expect(verifyChanged(f, receipt).exit).toBe(2);
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
