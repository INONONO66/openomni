import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode, execute, sha256 } from "./run-quality-mutations";

type Json = ReturnType<typeof decode>;
type RecordValue = { [key: string]: Json };
const roots: string[] = [];
const evidence: RecordValue[] = [];
class FixtureError {
	constructor(readonly message: string) { }
}
function record(value: Json | undefined): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new FixtureError("Expected report object");
	return value;
}
function rows(value: Json | undefined): Json[] {
	if (!Array.isArray(value)) throw new FixtureError("Expected report array");
	return value;
}
const tool = process.env.QUALITY_INVENTORY_TOOL ?? join(import.meta.dir, "quality-inventory.ts");
const decision = process.env.QUALITY_MUTATION_DECISION ?? join(import.meta.dir, "conformance/quality-mutation-contract.json");
// Fixtures compile and execute real Bun tests. They need the pinned compiler and
// its declarations, not Electron or every product dependency copied per mutant.
const dependencyRoot = mkdtempSync(join(tmpdir(), "omo-mutation-dependencies-"));
const locations = new Map<string, string>();
for (const [name, parent] of [["typescript", ""], ["@types/bun", ""], ["bun-types", "@types/bun"], ["@types/node", "bun-types"], ["undici-types", "@types/node"], ["zod", ""]]) {
	if (!name) throw new FixtureError("Missing dependency name");
	const location = dirname(Bun.resolveSync(`${name}/package.json`, locations.get(parent ?? "") ?? import.meta.dir));
	locations.set(name, location);
	const path = join(dependencyRoot, name);
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(location, path);
}
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
	if (path)
		writeFileSync(
			path,
			JSON.stringify(
				{
					runtime: Bun.version,
					toolSha256: pins.tool,
					decisionSha256: pins.decision,
					cases: evidence,
				},
				null,
				2,
			),
		);
});

async function fixture(source: string, assertion: string, additions: Record<string, string> = {}) {
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
	writeFileSync(
		join(root, "src/tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				types: ["bun"],
				skipLibCheck: true,
			},
			include: ["."],
		}),
	);
	writeFileSync(
		join(root, "contract.json"),
		JSON.stringify({
			version: 1,
			typescript: "5.9.2",
			roots: ["src"],
			projects: ["src/tsconfig.json"],
			topology: false,
		}),
	);
	const generated = await execute(
		[process.execPath, tool, "--root", root, "--contract", join(root, "contract.json")],
		root,
		15000,
	);
	expect(generated.exitCode).toBe(0);
	const inventory = join(root, "inventory.json");
	writeFileSync(inventory, generated.stdout);
	return { root, inventory, files };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertReportResults(report: RecordValue, selected: RecordValue[]): void {
	const results = rows(report.results).map(record);
	const census = rows(report.census).map(record);
	for (const row of census) {
		const candidates = results.filter((result) => result.path === row.path);
		const total = rows(row.operators)
			.map(record)
			.reduce((sum, op) => sum + Number(op.candidates), 0);
		expect(candidates).toHaveLength(total);
	}
	for (const [outcome, count] of Object.entries(record(report.counts)))
		expect(results.filter((result) => result.outcome === outcome)).toHaveLength(Number(count));
	for (const result of selected) {
		expect(result.replacementSha256).toBe(sha256(String(result.replacement)));
		expect(result.id).toBe(
			sha256(
				`${result.path}\0${result.startOffset}\0${result.endOffset}\0${result.replacementSha256}`,
			),
		);
		if (["killed", "survived"].includes(String(result.outcome)))
			expect(record(result.coverage).reached).toBe(true);
		if (result.outcome === "noCoverage") expect(record(result.coverage).reached).toBe(false);
	}
}
async function invoke(input: Fixture, name: string, args: string[] = [], alter: string[] = []) {
	const paths = {
		contract: join(input.root, "contract.json"),
		inventory: input.inventory,
		decision,
		"inventory-tool": tool,
	};
	const argv = [process.execPath, runner, "--root", input.root, "--dependencies", dependencies];
	for (const [key, path] of Object.entries(paths))
		argv.push(`--${key}`, path, `--${key}-sha256`, sha256(readFileSync(path)));
	const python = process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3";
	argv.push("--python", python);
	for (let index = 0; index < alter.length; index += 2) {
		const key = alter[index];
		const value = alter[index + 1];
		if (!key || !value) throw new FixtureError("Expected argument replacement pair");
		argv[argv.indexOf(key) + 1] = value;
	}
	const receipt = await execute([...argv, ...args], input.root, 90000);
	expect(receipt.timedOut).toBe(false);
	expect(receipt.overflow).toBe(false);
	expect(receipt.signal).toBeNull();
	const report = record(decode(receipt.stdout));
	expect(report.exitCode).toBe(receipt.exitCode);
	expect(report.globalZero).toBe(false);
	const selected = report.results
		? rows(report.results)
			.map(record)
			.filter((row) => row.selected === true)
		: [];
	if (report.results) assertReportResults(report, selected);
	evidence.push({
		name,
		exitCode: receipt.exitCode,
		full: report.full ?? null,
		complete: report.complete ?? null,
		counts: report.counts ?? null,
		selectedCounts: report.selectedCounts ?? null,
		error: report.error ?? null,
		errors: report.errors ?? null,
		runtime: Bun.version,
		stdoutSha256: receipt.stdoutSha256,
		stderrSha256: receipt.stderrSha256,
		selected: selected.map((row) => ({
			id: row.id ?? null,
			operator: row.operator ?? null,
			outcome: row.outcome ?? null,
			reason: row.reason ?? null,
			assertionIdentities: row.assertionIdentities ?? null,
			restored: row.restored ?? null,
		})),
		cleanupVerified: report.cleanupVerified ?? null,
		argv: [...argv, ...args],
		fixture: input.files,
		report,
		runnerSha256: sha256(readFileSync(runner)),
	});
	return { report, selected, code: receipt.exitCode };
}
function assertBehavioralKill(result: Awaited<ReturnType<typeof invoke>>): void {
	expect(result.code).toBe(0);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(1);
}
const select = (family: string) => ["--target", "src/a.ts", "--operator", family, "--limit", "1"];

const families = [
	{
		id: "boolean-literal",
		source: "export const run = () => true;",
		assert: "expect(run()).toBe(true);",
		outcome: "killed",
	},
	{
		id: "equality",
		source: "export const run = (a:number,b:number) => a === b;",
		assert: "expect(run(1,1)).toBe(true);",
		outcome: "killed",
	},
	{
		id: "relational",
		source: "export const run = (a:number,b:number) => a > b;",
		assert: "expect(run(2,1)).toBe(true);expect(run(1,1)).toBe(false);",
		outcome: "killed",
	},
	{
		id: "arithmetic",
		source: "export const run = (a:number,b:number) => a + b;",
		assert: "expect(run(2,1)).toBe(3);",
		outcome: "killed",
	},
	{
		id: "logical",
		source: "export const run = (a:boolean,b:boolean) => a && b;",
		assert: "expect(run(true,false)).toBe(false);",
		outcome: "killed",
	},
	{
		id: "bitwise",
		source: "export const run = (a:number,b:number) => a & b;",
		assert: "expect(run(2,1)).toBe(0);",
		outcome: "killed",
	},
	{
		id: "unary",
		source: "export const run = (a:boolean) => !a;",
		assert: "expect(run(true)).toBe(false);",
		outcome: "killed",
	},
	{
		id: "update",
		source: "export function run(n:number) {let x=n;return ++x;}",
		assert: "expect(run(2)).toBe(3);",
		outcome: "killed",
	},
	{
		id: "assignment",
		source: "export function run(x:number,n:number) {x+=n;return x;}",
		assert: "expect(run(3,2)).toBe(5);",
		outcome: "killed",
	},
	{
		id: "numeric-literal",
		source: "export const run = () => 42;",
		assert: "expect(run()).toBe(42);",
		outcome: "killed",
	},
	{
		id: "bigint-literal",
		source: "export const run = () => 42n;",
		assert: "expect(run()).toBe(42n);",
		outcome: "killed",
	},
	{
		id: "string-literal",
		source: 'export const run = () => "hello";',
		assert: 'expect(run()).toBe("hello");',
		outcome: "killed",
	},
	{
		id: "condition",
		source: "export function run(n:number){if(n)return 1;return 2;}",
		assert: "expect(run(1)).toBe(1);",
		outcome: "killed",
	},
	{
		id: "conditional-arm",
		source: "export const run = (n:number) => n ? 1 : 2;",
		assert: "expect(run(1)).toBe(1);",
		outcome: "killed",
	},
	{
		id: "statement-delete",
		source: "export function run(n:number){let x=0;x+=n;return x;}",
		assert: "expect(run(3)).toBe(3);",
		outcome: "killed",
	},
	{
		id: "return-value",
		source: "export function run():number|undefined{return 42;}",
		assert: "expect(run()).toBe(42);",
		outcome: "killed",
	},
	{
		id: "throw-delete",
		source: 'export function run(){throw new Error("boom");}',
		assert: "expect(run).toThrow();",
		outcome: "killed",
	},
	{
		id: "array-literal",
		source: "export const run = ():number[] => [1,2];",
		assert: "expect(run()).toEqual([1,2]);",
		outcome: "killed",
	},
	{
		id: "object-literal",
		source: "export const run = () => ({value:1});",
		assert: "expect(run()).toEqual({value:1});",
		outcome: "killed",
	},
	{
		id: "optional-chain",
		source: "export const run = (n:{value:number}) => n?.value;",
		assert: "expect(run({value:3})).toBe(3);",
		outcome: "survived",
	},
	{
		id: "await-delete",
		source:
			"export async function run(){const result=await Promise.resolve(3);return typeof result;}",
		assert: 'expect(await run()).toBe("number");',
		outcome: "killed",
	},
	{
		id: "switch-case",
		source:
			'export function run(n:number){switch(n){case 0:return "zero";default:return "other";}}',
		assert: 'expect(run(0)).toBe("zero");',
		outcome: "killed",
	},
	{
		id: "regex",
		source: "export const run = (s:string) => /^foo+$/.test(s);",
		assert:
			'expect(run("foo")).toBe(true);expect(run("fo")).toBe(false);expect(run("zfoo")).toBe(false);expect(run("fooz")).toBe(false);expect(run("FOO")).toBe(false);',
		outcome: "killed",
	},
	{
		id: "method",
		source: "export const run = (n:number[]) => n.filter(x=>x>0);",
		assert: "expect(run([-1,1])).toEqual([1]);",
		outcome: "killed",
	},
];
for (const family of families)
	test(`real operator seam: ${family.id}`, async () => {
		const input = await fixture(family.source, family.assert);
		const before = sha256(readFileSync(join(input.root, "src/a.ts")));
		const { report, selected, code } = await invoke(input, family.id, select(family.id));
		expect(code).toBe(family.outcome === "killed" ? 0 : 1);
		expect(report.full).toBe(false);
		expect(report.mutationZero).toBe(false);
		expect(report.complete).toBe(true);
		expect(report.cleanupVerified).toBe(true);
		expect(report.originalHashesVerified).toBe(true);
		expect(selected).toHaveLength(1);
		expect(selected[0]?.outcome).toBe(family.outcome);
		expect(selected[0]?.restored).toBe(true);
		if (family.outcome === "killed")
			expect(rows(selected[0]?.assertionIdentities).length).toBeGreaterThan(0);
		expect(sha256(readFileSync(join(input.root, "src/a.ts")))).toBe(before);
		for (const row of rows(report.census).map(record)) expect(rows(row.operators)).toHaveLength(24);
	}, 90000);

test("review R2: negated assertion is a behavioral kill", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).not.toBe(false);");
	const result = await invoke(input, "review-negated", select("boolean-literal"));
	assertBehavioralKill(result);
}, 90000);

test("review R3: optional method preserves its receiver", async () => {
	const input = await fixture(
		"const value = { n: 3, method() { return this.n; } }; export const run = () => value?.method();",
		"expect(run()).toBe(3);",
	);
	const result = await invoke(input, "review-receiver", select("optional-chain"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("survived");
}, 90000);

test("weak assertion survives; original location is really covered", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(typeof run()).toBe("boolean");',
	);
	const result = await invoke(input, "survivor", select("boolean-literal"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("survived");
}, 90000);

test("uninvoked function is noCoverage, not survived", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(typeof run).toBe("function");',
	);
	const result = await invoke(input, "noCoverage", select("boolean-literal"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("noCoverage");
}, 90000);

test("compiler rejection stays invalid and cannot make an all-invalid run green", async () => {
	const input = await fixture("export const run = ():true => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "invalid", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("invalid");
	expect(record(result.report.counts).killed).toBe(0);
	expect(rows(result.selected[0]?.receipts)).toHaveLength(1);
}, 90000);

test("crash after a successful assertion is infrastructure despite Bun JUnit label", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(1).toBe(1);if(!run())throw new Error("crash-not-assertion");',
	);
	const result = await invoke(input, "crash-after-assertion", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
	expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(0);
}, 90000);

test("bounded mutant hang is infrastructure, not killed", async () => {
	const input = await fixture(
		"export const run = () => true;",
		"if(!run()){while(true){}}expect(run()).toBe(true);",
	);
	const result = await invoke(input, "timeout", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
	expect(result.selected[0]?.typecheck).toBe("valid");
	expect(result.selected[0]?.reason).toBe("failure-without-complete-behavioral-assertions");
	expect(rows(result.selected[0]?.receipts).map(record).at(-1)?.timedOut).toBe(true);
}, 90000);

test("exhausted budget accounts every candidate as uncompleted", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "budget", ["--budget", "1"]);
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
	expect(result.selected.every((row) => row.outcome === "uncompleted")).toBe(true);
	expect(result.selected.length).toBeGreaterThan(0);
}, 90000);

test("work budget cannot silently turn an unfinished full run into a selected pass", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "max-candidates", ["--max-candidates", "1"]);
	expect(result.code).toBe(2);
	expect(result.selected.length).toBeGreaterThan(1);
	expect(result.selected.filter((row) => row.outcome !== "uncompleted")).toHaveLength(1);
	expect(result.report.full).toBe(false);
}, 90000);

test("a same-name replacement contract cannot weaken the frozen operators", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const changed = record(decode(readFileSync(decision, "utf8")));
	const contract = record(changed.contract);
	const mutation = record(contract.mutation);
	const operators = rows(mutation.operators).map((value, index) =>
		index === 0 ? { ...record(value), replacements: { true: ["true"], false: ["false"] } } : value,
	);
	const path = join(input.root, "changed-decision.json");
	writeFileSync(
		path,
		JSON.stringify({ ...changed, contract: { ...contract, mutation: { ...mutation, operators } } }),
	);
	const result = await invoke(input, "weakened-operators", select("boolean-literal"), [
		"--decision",
		path,
		"--decision-sha256",
		sha256(readFileSync(path)),
	]);
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("operatorContract");
}, 90000);

test("JSON schema errors do not reach test execution", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	writeFileSync(input.inventory, '{"version":2}');
	const result = await invoke(input, "invalid-schema", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("schema");
}, 90000);

test("candidate identity and AST census are deterministic across isolated copies", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const first = await invoke(input, "determinism-first", select("boolean-literal"));
	const second = await invoke(input, "determinism-second", select("boolean-literal"));
	expect(first.code).toBe(0);
	expect(second.code).toBe(0);
	const identity = (row: RecordValue) => ({
		id: row.id,
		path: row.path,
		start: row.startOffset,
		end: row.endOffset,
		operator: row.operator,
		replacement: row.replacement,
		outcome: row.outcome,
	});
	expect(first.selected.map(identity)).toEqual(second.selected.map(identity));
	expect(first.report.census).toEqual(second.report.census);
	expect(first.report.executionTreeSha256).toBe(second.report.executionTreeSha256);
}, 90000);

test("probe side effects cannot contaminate the fresh mutation copy", async () => {
	const input = await fixture(
		"export const run = (n:number) => n+1;",
		'const fs=await import("node:fs");if(fs.existsSync("state"))throw new Error("leaked-state");fs.writeFileSync("state","created");expect(run(1)).toBe(2);',
	);
	const result = await invoke(input, "isolated-snapshots", select("arithmetic"));
	expect(result.code).toBe(0);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(existsSync(join(input.root, "state"))).toBe(false);
}, 90000);

test("unfiltered execution includes mutations of tests and cannot claim global zero", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "full-census");
	expect(result.report.full).toBe(true);
	expect(record(result.report.counts).uncompleted).toBe(0);
	expect(result.selected.some((row) => row.path === "src/a.test.ts")).toBe(true);
	expect(result.selected.some((row) => row.outcome === "survived")).toBe(true);
	expect(result.code).not.toBe(0);
}, 90000);

test("frozen inventory omission is an analysis error from canonical verifier", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	writeFileSync(join(input.root, "src/unlisted.ts"), "export const omitted = 3;");
	const result = await invoke(input, "incomplete-inventory", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("incompleteInventory");
}, 90000);

test("tampered frozen input cannot pass with stale hash", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "tamper", select("boolean-literal"), [
		"--inventory-sha256",
		"0".repeat(64),
	]);
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("tamper");
}, 90000);

test("malformed Python input remains enumerated and blocks execution", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/driver.py": "def run(:\n    return True\n",
	});
	const result = await invoke(input, "malformed-python", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(
		rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/driver.py")?.syntax,
	).toBe("python-analysis-error");
	expect(result.report.full).toBe(false);
}, 90000);

test("invalid TS syntax does not become a behavioral kill", async () => {
	const input = await fixture("export const run = ( => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "unsupported-ts-syntax", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(
		rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/a.ts")?.syntax,
	).toBe("unsupportedSyntax");
}, 90000);

test("missing CLI input and baseline growth flags are analysis errors", async () => {
	for (const args of [[], ["--update", "true"]]) {
		const result = await execute([process.execPath, runner, ...args], import.meta.dir, 15000);
		const report = record(decode(result.stdout));
		expect(result.exitCode).toBe(2);
		expect(report.complete).toBe(false);
		evidence.push({
			name: args.length ? "reject-update" : "missing-input",
			exitCode: result.exitCode,
			error: report.error ?? null,
		});
	}
});

test("typed JSON boundary rejects executable syntax and duplicate keys", () => {
	for (const value of ['{"a":true,"a":false}', '{"a":undefined}', '{"a":()=>1}'])
		expect(() => decode(value)).toThrow();
	expect(decode('{"a":[true,null,-2,"unknown any"]}')).toEqual({
		a: [true, null, -2, "unknown any"],
	});
});

for (const assertion of [
	'await expect(run()?Promise.reject(new Error("expected")):Promise.resolve(3)).rejects.toBeInstanceOf(Error);',
	'await expect(run()?Promise.resolve(3):Promise.reject(new Error("mutated"))).resolves.toBe(3);',
])
	test("wrong promise settlement is a genuine assertion failure", async () => {
		const input = await fixture("export const run=()=>true;", assertion);
		const result = await invoke(input, "promise-settlement", select("boolean-literal"));
		assertBehavioralKill(result);
	}, 90000);

test("passing self-closing JUnit cases cannot steal a grouped failure identity", async () => {
	const input = await fixture("export const run=()=>true;", "", {
		"src/a.test.ts":
			'import {describe,test,expect} from "bun:test";import {run} from "./a";test("first passing",()=>{expect(1).toBe(1);});describe("group",()=>{test("behavior",()=>{expect(run()).not.toBe(false);});});',
	});
	const result = await invoke(input, "grouped-negated", select("boolean-literal"));
	expect(result.code).toBe(0);
	const identities = rows(result.selected[0]?.assertionIdentities);
	expect(identities).toHaveLength(1);
	expect(record(decode(String(identities[0]))).name).toBe("behavior");
}, 90000);

const pythonEntry =
	'export async function run(){const child=Bun.spawn(["python3","src/driver.py"],{stdout:"pipe",stderr:"pipe"}); const output=await new Response(child.stdout).text(); const error=await new Response(child.stderr).text(); const exit=await child.exited; if(exit!==0)throw new Error(error); return output.trim();}';
const pythonFamilies = [
	{ id: "py-boolean", code: "print(True)", output: "True" },
	{ id: "py-equality", code: "print(1 == 1)", output: "True" },
	{ id: "py-relational", code: "print(1 < 1)", output: "False" },
	{ id: "py-arithmetic", code: "print(2 + 1)", output: "3" },
	{ id: "py-logical", code: "print(True and False)", output: "False" },
	{ id: "py-unary", code: "print(not True)", output: "False" },
	{ id: "py-number", code: "print(42)", output: "42" },
	{ id: "py-string", code: "print('hello')", output: "hello" },
	{ id: "py-condition", code: "print(1 if 1 else 2)", output: "1" },
	{ id: "py-expression-delete", code: "print('hello')", output: "hello" },
	{ id: "py-return", code: "def run():\n    return 42\nprint(run())", output: "42" },
	{
		id: "py-raise",
		code: "try:\n    raise ValueError('boom')\nexcept ValueError:\n    print('raised')",
		output: "raised",
	},
	{ id: "py-container", code: "print([1, 2])", output: "[1, 2]" },
	{
		id: "py-assert",
		code: "try:\n    assert False\nexcept AssertionError:\n    print('asserted')",
		output: "asserted",
	},
	{
		id: "py-await",
		code: "import asyncio\nasync def inner():\n    return 3\nasync def run():\n    result = await inner()\n    return type(result).__name__\nprint(asyncio.run(run()))",
		output: "int",
	},
];
for (const family of pythonFamilies)
	test(`real Python operator seam: ${family.id}`, async () => {
		const input = await fixture(
			pythonEntry,
			`expect(await run()).toBe(${JSON.stringify(family.output)});`,
			{ "src/driver.py": `${family.code}\n` },
		);
		const result = await invoke(input, family.id, [
			"--target",
			"src/driver.py",
			"--operator",
			family.id,
			"--limit",
			"1",
		]);
		expect(result.code).toBe(0);
		expect(result.selected).toHaveLength(1);
		expect(result.selected[0]?.outcome).toBe("killed");
		expect(result.selected[0]?.restored).toBe(true);
		expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(1);
		const census = rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/driver.py");
		expect(census?.syntax).toBe("parsed");
		expect(rows(census?.operators)).toHaveLength(15);
		const candidates = rows(result.report.results)
			.map(record)
			.filter((row) => row.path === "src/driver.py");
		const count = rows(census?.operators)
			.map(record)
			.reduce((total, row) => total + Number(row.candidates), 0);
		expect(candidates).toHaveLength(count);
		expect(record(result.report.pythonCapability).implemented).toBe(true);
		expect(result.report.originalHashesVerified).toBe(true);
		expect(result.report.cleanupVerified).toBe(true);
	}, 90000);

for (const fixtureCase of [
	{
		name: "python-survivor",
		source: "print(True)\n",
		assertion: 'expect(typeof await run()).toBe("string");',
		code: 1,
		outcome: "survived",
	},
	{
		name: "python-noCoverage",
		source: "def dormant():\n    return True\nprint('ready')\n",
		assertion: 'expect(await run()).toBe("ready");',
		code: 1,
		outcome: "noCoverage",
	},
	{
		name: "python-crash",
		source: "if not True:\n    raise RuntimeError('mutated')\nprint('ready')\n",
		assertion: 'expect(await run()).toBe("ready");',
		code: 2,
		outcome: "infrastructure",
	},
])
	test(`real Python outcome: ${fixtureCase.name}`, async () => {
		const input = await fixture(pythonEntry, fixtureCase.assertion, {
			"src/driver.py": fixtureCase.source,
		});
		const result = await invoke(input, fixtureCase.name, [
			"--target",
			"src/driver.py",
			"--operator",
			"py-boolean",
			"--limit",
			"1",
		]);
		expect(result.code).toBe(fixtureCase.code);
		expect(result.selected[0]?.outcome).toBe(fixtureCase.outcome);
	}, 90000);

test("missing Python runtime never becomes a zero-candidate pass", async () => {
	const input = await fixture(pythonEntry, 'expect(await run()).toBe("True");', {
		"src/driver.py": "print(True)\n",
	});
	const result = await invoke(input, "missing-python-runtime", select("boolean-literal"), [
		"--python",
		"/not/a/python",
	]);
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
}, 90000);

for (const example of [
	{
		name: "R2-1 precedence",
		source: "print(~(1 + 2) * 0)\n",
		mutant: "print((1 + 2) * 0)\n",
		operator: "py-unary",
		output: "0",
		mutatedOutput: "0",
		outcome: "survived",
		exit: 1,
	},
	{
		name: "R2-2 literal pattern",
		source: "value = int('1')\nmatch value:\n    case 1:\n        print('one')\n",
		mutant: "value = int('1')\nmatch value:\n    case 0:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern singleton",
		source: "value = bool('yes')\nmatch value:\n    case True:\n        print('one')\n",
		mutant: "value = bool('yes')\nmatch value:\n    case False:\n        print('one')\n",
		operator: "py-boolean",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern mapping key",
		source: "value = {int('1'): 'value'}\nmatch value:\n    case {1: x}:\n        print(x)\n",
		mutant: "value = {int('1'): 'value'}\nmatch value:\n    case {0: x}:\n        print(x)\n",
		operator: "py-number",
		output: "value",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern sequence",
		source: "value = [int('1')]\nmatch value:\n    case [1]:\n        print('one')\n",
		mutant: "value = [int('1')]\nmatch value:\n    case [0]:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern signed literal",
		source: "value = int('-1')\nmatch value:\n    case -1:\n        print('one')\n",
		mutant: "value = int('-1')\nmatch value:\n    case -0:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern unreached later case",
		source:
			"value = 'first'\nmatch value:\n    case 'first':\n        print('first')\n    case 1:\n        print('one')\n",
		mutant:
			"value = 'first'\nmatch value:\n    case 'first':\n        print('first')\n    case 0:\n        print('one')\n",
		operator: "py-number",
		output: "first",
		mutatedOutput: "first",
		outcome: "noCoverage",
		exit: 1,
	},
])
	test(`review R2 counterexample: ${example.name}`, async () => {
		const input = await fixture(
			pythonEntry,
			`expect(await run()).toBe(${JSON.stringify(example.output)});`,
			{
				"src/driver.py": example.source,
			},
		);
		for (const [program, output] of [
			[example.source, example.output],
			[example.mutant, example.mutatedOutput],
		]) {
			if (program === undefined || output === undefined)
				throw new FixtureError("Missing native control");
			const native = await execute(
				[process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3", "-c", program],
				input.root,
				15000,
			);
			expect(native.exitCode).toBe(0);
			expect(native.stdout.trim()).toBe(output);
			evidence.push({ name: `${example.name}: independent native control`, program, ...native });
		}
		const result = await invoke(input, example.name, [
			"--target",
			"src/driver.py",
			"--operator",
			example.operator,
		]);
		expect(result.code).toBe(example.exit);
		expect(result.selected).toHaveLength(1);
		expect(result.selected[0]?.outcome).toBe(example.outcome);
		expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(
			example.outcome === "killed" ? 1 : 0,
		);
		expect(result.report.originalHashesVerified).toBe(true);
		expect(result.report.cleanupVerified).toBe(true);
	}, 90000);

for (const source of [
	"let reads=0; const value={n:3,get method(){reads++;return function(this:{n:number}){return this.n;}}}; export const run=()=>[value?.method(),reads];",
	"let calls=0; const value={n:3,method(x:number){return this.n+x;}}; export const run=()=>[value?.method?.(++calls),calls];",
	"let keys=0; const value={n:3,method(){return this.n;}}; export const run=()=>[value?.[(++keys,'method')](),keys];",
])
	test("optional reference probe preserves single evaluation", async () => {
		const expected = source.includes("++calls") ? "[4,1]" : "[3,1]";
		const input = await fixture(source, `expect(run()).toEqual(${expected});`);
		const result = await invoke(input, "reference-effects", select("optional-chain"));
		expect(result.code).toBe(1);
		expect(result.selected[0]?.outcome).toBe("survived");
	}, 90000);

test("optional chain probe keeps skipped key and argument effects lazy", async () => {
	const input = await fixture(
		"let effects=0; const values:{method(x:number):number}[]=[]; const get=()=>values[0]!; export const run=():(number|undefined)[]=>[get()?.[(++effects,'method')](++effects),effects];",
		"expect(run()).toEqual([undefined,0]);",
	);
	const result = await invoke(input, "optional-lazy-effects", select("optional-chain"));
	// Removing ?. is itself a runtime error, but the ORIGINAL probe must be green.
	expect(result.code).toBe(2);
	expect(result.selected[0]?.reason).toBe("failure-without-complete-behavioral-assertions");
	const receipts = rows(result.selected[0]?.receipts).map(record);
	expect(receipts[1]?.exitCode).toBe(0);
}, 90000);

test("ordinary interpolated template has a runtime string mutant", async () => {
	const input = await fixture(
		`export const run=(s:string)=>\`hello \${s}\`;`,
		'expect(run("world")).toBe("hello world");',
	);
	const result = await invoke(input, "interpolated-string", select("string-literal"));
	expect(result.code).toBe(0);
	expect(result.selected[0]?.replacement).toBe('""');
}, 90000);

test("tagged template probe preserves tag receiver, raw data and substitutions", async () => {
	const input = await fixture(
		`let effects=0; const owner={n:3,tag(parts:TemplateStringsArray,x:number){return [this.n,parts.raw[0],x,effects];}}; export const run=()=>owner.tag\`hello\\n\${++effects}tail\`;`,
		'expect(run()).toEqual([3,"hello\\\\n",1,1]);',
	);
	const result = await invoke(input, "tagged-template", select("string-literal"));
	expect(result.code).toBe(0);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(rows(result.selected[0]?.receipts).map(record)[1]?.exitCode).toBe(0);
}, 90000);

test("canonical TS and JS outside native includes get inventory fallback ownership", async () => {
	const input = await fixture("export const run=()=>true;", "expect(run()).toBe(true);", {
		"src/excluded/loose.ts": "export const loose=()=>true;",
		"src/excluded/loose.js": "export const loose=()=>true;",
	});
	const config = join(input.root, "src/tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({ ...record(decode(readFileSync(config, "utf8"))), exclude: ["excluded"] }),
	);
	const generated = await execute(
		[process.execPath, tool, "--root", input.root, "--contract", join(input.root, "contract.json")],
		input.root,
		15000,
	);
	expect(generated.exitCode).toBe(0);
	writeFileSync(input.inventory, generated.stdout);
	const result = await invoke(input, "inventory-fallback", select("boolean-literal"));
	expect(result.code).toBe(0);
	for (const path of ["src/excluded/loose.ts", "src/excluded/loose.js"]) {
		const row = rows(result.report.census)
			.map(record)
			.find((item) => item.path === path);
		expect(row?.syntax).toBe("parsed");
		expect(
			rows(row?.operators)
				.map(record)
				.find((op) => op.operator === "boolean-literal")?.candidates,
		).toBe(1);
	}
}, 90000);

test("assertion identity cannot credit another testcase's crash", async () => {
	const input = await fixture("export const run=()=>true;", "expect(run()).not.toBe(false);", {
		"src/crash.test.ts":
			'import {test,expect} from "bun:test";import {run} from "./a";test("separate crash",()=>{expect(1).toBe(1);if(!run())throw new Error("crash");});',
	});
	const result = await invoke(input, "mixed-assertion-crash", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
}, 90000);

test("missing executable reports infrastructure without leaking resources", async () => {
	const result = await execute(["/not/a/real/executable"], import.meta.dir, 1000);
	expect(result.spawnError).toBe(true);
	expect(result.exitCode).not.toBe(0);
	expect(result.timedOut).toBe(false);
	expect(existsSync("/not/a/real/executable")).toBe(false);
});
