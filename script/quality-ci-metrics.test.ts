import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprint, readDocument } from "./quality-ci-input";
import { joinBounds, measureStatic } from "./quality-ci-metrics";
import { parseStatic } from "./quality-ci-legs";
import { InventoryError } from "./quality-inventory";
import { toolReceipts } from "./quality-metrics/tool";
import { collectExactFixture } from "./quality-coverage-fixture";
import { readExactCoverage } from "./quality-ci-coverage";

function prepareFixture(root: string): void {
	mkdirSync(join(root, "script"));
	writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
	writeFileSync(join(root, "contract.json"), JSON.stringify({
		version: 1, typescript: "5.9.2", roots: ["script"],
		projects: ["script/tsconfig.json"], topology: false,
	}));
}
function fixtureIdentity(root: string) {
	const identity = fingerprint(root, "contract.json");
	writeFileSync(join(root, "inventory.json"), JSON.stringify(identity.inventory));
	return identity;
}

test("static pinned analyzers survive JSON transfer and join conservative bounds", async () => {
	const root = mkdtempSync(join(tmpdir(), "quality-bound-native-"));
	try {
		prepareFixture(root);
		writeFileSync(join(root, "script/a.ts"), "export function answer(value: boolean): number {\n  if (value) return 1;\n  return 2;\n}\nexport function branching(a: boolean, b: boolean, c: boolean, d: boolean): number {\n  if (a) return 1;\n  if (b) return 2;\n  if (c) return 3;\n  if (d) return 4;\n  return 5;\n}\n");
		writeFileSync(join(root, "script/main.test.ts"), 'import { test, expect } from "bun:test"; import { answer } from "./a"; test("taken", () => { expect(answer(true)).toBe(1); });\n');
		const identity = fixtureIdentity(root);
		const inventory = join(root, "inventory.json");
		// Other tests invoke these analyzers in the same process. Own the receipt
		// boundary before measurement rather than depending on shard file order.
		toolReceipts();
		const collected = await measureStatic({ root, inventory });
		writeFileSync(join(root, "static.json"), JSON.stringify(collected));
		const document = parseStatic(readDocument(join(root, "static.json")));
		expect(document).toEqual(collected);
		expect(document.analyzerProcesses.map((row) => row.operation)).toEqual(["javascript", "coverage", "javascript", "coverage", "clones"]);
		expect(document.analyzerProcesses.map((row) => row.transport)).toEqual(["in-process", "in-process", "in-process", "in-process", "process"]);
		for (const row of document.analyzerProcesses.slice(0, 4)) {
			expect(row.pid).toBeUndefined();
			expect(row.exitCode).toBeUndefined();
		}
		expect(document.analyzerProcesses[4]?.pid).toBeGreaterThan(0);
		expect(document.analyzerProcesses[4]?.exitCode).toBe(0);
		expect(document.pythonProcesses).toEqual([]);
		expect(document.sources).toEqual(identity.inventory.files.map(({ path, sha256 }) => ({ path, sha256 })));
		expect(() => joinBounds(document, { identity })).toThrow("missing exact statement evidence");
		writeFileSync(join(root, "ci-plan.json"), JSON.stringify({ version: 2, class: "global", qualityScope: identity.inventory.files.map((row) => row.path), projects: ["script/tsconfig.json"] }));
		const options = { root, contract: join(root, "contract.json"), directory: join(root, "exact"), plan: join(root, "ci-plan.json"), run: "metrics-run" };
		collectExactFixture(options, [{ id: "tests", kind: "test", paths: ["script/main.test.ts"], args: [], expectedExitCode: 0 }]);
		const coverage = await readExactCoverage(options, identity, document.measured.map((row) => row.analysis.prepared));
		const result = joinBounds(document, { identity, coverage });
		const preparedStarts = [...new Set(
			Object.values(document.measured[0]?.analysis.prepared.statementMap ?? {}).map((range) => range.start.line),
		)].sort((a, b) => a - b);
		expect(result.executableLines[0]?.lines).toEqual(preparedStarts);
		expect(result.algorithm).toBe("d945-exact-statement-evidence@1");
		expect(result.complete).toBe(true);
		const answer = result.records.find((row) => row.name === "answer");
		expect(answer?.cyclomatic).toBe(2);
		expect(answer?.crap).toBeLessThan(6);
		expect(result.measurement.findings.find((row) => row.gate === "crap")).toMatchObject({ path: "script/a.ts", line: 5, endLine: 11, symbol: "FunctionDeclaration:branching", value: 30 });
		expect(result.measurement.analyzed).toContain("coverage");
		expect(result.measurement.findings.some((row) => row.gate === "coverage")).toBe(true);
		expect(result.duplication.inspected).toHaveLength(2);
		const unselected = joinBounds(document, { identity, coverage, selectedLanes: ["apps/unrelated"] });
		expect(unselected.coverageScope).toEqual(["apps/unrelated"]);
		expect(unselected.measurement.findings.some((row) => row.gate === "coverage" || row.gate === "crap")).toBe(false);
		expect(unselected.records.map((row) => row.cyclomatic)).toEqual(result.records.map((row) => row.cyclomatic));
		const uncovered = result.measurement.findings.filter((row) => row.gate === "coverage" && row.path === "script/a.ts");
		expect(uncovered.some((row) => row.line === 3)).toBe(true);
		expect(uncovered.some((row) => row.line === 2)).toBe(false);
		for (const changed of [{ ...document, inventoryHash: "stale" }, { ...document, contractHash: "stale" }, { ...document, complete: false }, { ...document, version: 2 }]) {
			expect(() => joinBounds(changed, { identity, coverage })).toThrow(InventoryError);
		}
		writeFileSync(join(root, "script/a.ts"), "export const changed = 1;\n");
		expect(() => joinBounds(document, { identity: fingerprint(root, "contract.json"), coverage })).toThrow(InventoryError);
		await expect(measureStatic({ root, inventory })).rejects.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("scoped metrics retain clone evidence from unselected sources", async () => {
	const root = mkdtempSync(join(tmpdir(), "quality-scoped-clones-"));
	try {
		prepareFixture(root);
		const duplicate = `export function duplicate(value: number): number {
	if (value < 0) return 0;
	if (value === 0) return 1;
	if (value === 1) return 2;
	if (value === 2) return 3;
	if (value === 3) return 4;
	return value + 5;
}
		`;
		writeFileSync(join(root, "script/a.ts"), duplicate);
		writeFileSync(join(root, "script/b.ts"), duplicate);
		fixtureIdentity(root);
		const inventory = join(root, "inventory.json");
		const scoped = await measureStatic({ root, inventory, scope: ["script/a.ts"] });
		expect(scoped.measured.map((row) => row.source.path)).toEqual(["script/a.ts"]);
		expect(scoped.cloneSources?.map((source) => source.path).sort()).toEqual(["script/a.ts", "script/b.ts"]);
		expect(scoped.duplication.clusters.some((cluster) =>
			cluster.occurrences.map((occurrence) => occurrence.path).sort().join(",") === "script/a.ts,script/b.ts",
		)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
