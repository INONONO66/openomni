import { afterAll, afterEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode, execute, sha256 } from "./run-quality-mutations";

export function mutationFixture(scenario: string) {
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
	const path = process.env.QUALITY_MUTATION_EVIDENCE ? `${process.env.QUALITY_MUTATION_EVIDENCE}.${scenario}.json` : undefined;
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

return { fixture, invoke, select, assertBehavioralKill, record, rows, evidence, tool, decision, runner, FixtureError };
}
