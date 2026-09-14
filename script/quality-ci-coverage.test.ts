import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExactCoverage, readNativeCoverage } from "./quality-ci-coverage";
import { digest, jsonArray, jsonObject } from "./quality-inventory";
import { parseNativeLcov } from "./quality-native-lcov";
import { collectExactFixture, coverageLaneFixture } from "./quality-coverage-fixture";
import { recordObject } from "./quality-ci-input";
import { prepare } from "./quality-metrics/coverage";
import { loadInventory } from "./quality-metrics/input";

test("CI consumes run-bound original counters and rejects stale, tampered or missing descendant evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "quality-exact-ci-"));
	try {
		mkdirSync(join(root, "script"));
		writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{"strict":true}}');
		writeFileSync(join(root, "contract.json"), JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false }));
		writeFileSync(join(root, "ci-plan.json"), JSON.stringify({ matrix: { include: [{ dir: "script", coverage: true }] } }));
		const source = 'function childOnly() {\n  return 42;\n}\nexport function dormant() {\n  return 7;\n}\nconsole.log(childOnly());\n';
		writeFileSync(join(root, "script/child.ts"), source);
		writeFileSync(join(root, "script/main.test.ts"), 'import { test, expect } from "bun:test"; test("descendant result", async () => { const child = Bun.spawn([process.execPath, "script/child.ts"], {stdout:"pipe"}); const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]); expect(code).toBe(0); expect(output).toBe("42\\n"); });\n');
		const options = { root, contract: join(root, "contract.json"), directory: join(root, "coverage"), plan: join(root, "ci-plan.json"), run: "exact-ci-run" };
		const identity = collectExactFixture(options, [{ id: "tests", kind: "test", paths: ["script/main.test.ts"], args: [], expectedExitCode: 0 }]);
		const inventoryPath = join(options.directory, "exact.inventory.json"), planPath = join(options.directory, "exact.plan.json"), path = join(options.directory, "exact.coverage.json");
		const inventory = loadInventory(root, inventoryPath), prepared = inventory.files.map(prepare);
		const evidence = readExactCoverage(options, identity, prepared);
		expect(evidence.processes).toHaveLength(2);
		expect(evidence.processes.filter((process) => process.parent)).toHaveLength(1);
		const child = prepared.find((file) => file.path === "script/child.ts");
		if (!child) throw new Error("missing child map");
		const countsAt = (line: number) => Object.entries(child.statementMap).filter(([, span]) => span.start.line === line).map(([id]) => evidence.totals.get(child.path)?.s[id]);
		expect(countsAt(2)).toEqual([1]);
		expect(countsAt(5)).toEqual([0]);
		const scoped = readExactCoverage(options, identity, [child]);
		expect(scoped.totals.size).toBe(1);
		expect(scoped.totals.get(child.path)).toEqual(evidence.totals.get(child.path));
		expect(() => readExactCoverage({ ...options, run: "another-run" }, identity, prepared)).toThrow();
		const planBytes = readFileSync(planPath), receiptBytes = readFileSync(path), hashBytes = readFileSync(`${path}.sha256`);
		const plan = recordObject(planPath);
		writeFileSync(planPath, JSON.stringify({ ...plan, run: { id: "relabelled", selectionHash: digest(readFileSync(options.plan)) } }));
		expect(() => readExactCoverage({ ...options, run: "relabelled" }, identity, prepared)).toThrow();
		writeFileSync(planPath, planBytes);
		writeFileSync(path, `${receiptBytes.toString()} `);
		expect(() => readExactCoverage(options, identity, prepared)).toThrow("exact coverage bytes changed");
		writeFileSync(path, receiptBytes);
		for (const defect of ["child", "counter", "map"]) {
			const receipt = recordObject(path);
			const processes = jsonArray(receipt.processes, jsonObject);
			if (defect === "child") receipt.processes = processes.filter((process) => process.parent === "");
			if (defect === "counter") {
				const process = processes.find((process) => process.parent !== "");
				if (!process) throw new Error("missing child receipt");
				jsonObject(jsonObject(process.coverage)[child.path]).s = {};
			}
			if (defect === "map") jsonObject(jsonArray(receipt.maps, jsonObject)[0]).mapHash = "0".repeat(64);
			const bytes = JSON.stringify(receipt);
			writeFileSync(path, bytes); writeFileSync(`${path}.sha256`, digest(bytes));
			expect(() => readExactCoverage(options, identity, prepared)).toThrow();
			writeFileSync(path, receiptBytes); writeFileSync(`${path}.sha256`, hashBytes);
		}
		writeFileSync(join(root, child.path), `${source}// drift\n`);
		expect(() => readExactCoverage(options, identity, prepared)).toThrow();
		writeFileSync(join(root, child.path), source);
		for (const file of [inventoryPath, planPath, path, `${path}.sha256`]) {
			const bytes = readFileSync(file); rmSync(file);
			expect(() => readExactCoverage(options, identity, prepared)).toThrow("missing exact statement evidence");
			writeFileSync(file, bytes);
		}
		expect(readFileSync(join(root, child.path), "utf8")).toBe(source);
	} finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test("coverage aggregation unions executing lanes and drops zero-only files", () => {
	const root = mkdtempSync(join(tmpdir(), "quality-aggregate-union-"));
	try {
		const run = "native-run", identity = { paths: ["packages/machines/a.ts", "script/a.ts", "script/never.ts"], typescript: [], inventoryHash: "a".repeat(64), contractHash: "b".repeat(64) };
		mkdirSync(join(root, "packages/machines"), { recursive: true }); mkdirSync(join(root, "script"));
		writeFileSync(join(root, "packages/machines/a.ts"), "export const a = 1;\n"); writeFileSync(join(root, "script/a.ts"), "export const a = 1;\nexport const b = 2;\n"); writeFileSync(join(root, "script/never.ts"), "export const never = 1;\n");
		const plan = join(root, "plan.json"); writeFileSync(plan, JSON.stringify({ matrix: { include: [{ dir: "packages/machines", coverage: true }, { dir: "script", coverage: true }] } }));
		const make = (lane: string, lcov: string) => ({ version: 1, complete: true, lane, run, runtime: Bun.version, inventoryHash: identity.inventoryHash, lcovHash: digest(lcov), lcov, files: parseNativeLcov(lcov, lane) });
		const machine = make("packages/machines", "SF:a.ts\nDA:1,2\nLF:1\nLH:1\nend_of_record\nSF:../../script/a.ts\nDA:1,0\nDA:2,0\nLF:2\nLH:0\nend_of_record\nSF:../../script/never.ts\nDA:1,0\nLF:1\nLH:0\nend_of_record\n");
		const script = make("script", "SF:../packages/machines/a.ts\nDA:1,3\nLF:1\nLH:1\nend_of_record\nSF:a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n");
		writeFileSync(join(root, "packages-machines.json"), JSON.stringify(machine)); writeFileSync(join(root, "script.json"), JSON.stringify(script));
		const result = readNativeCoverage({ root, directory: root, plan, run }, identity);
		expect(result.lines.get("packages/machines/a.ts")?.get(1)).toBe(3);
		expect(result.lines.get("script/a.ts")?.get(1)).toBe(1);
		expect(result.lines.get("script/a.ts")?.has(2)).toBe(false);
		expect(result.lines.get("script/never.ts")).toEqual(new Map([[1, 0]]));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([3, 0])("coverage aggregation preserves uncovered lines with %i target hits in either lane order", (hits) => {
	const root = mkdtempSync(join(tmpdir(), "quality-aggregate-guard-"));
	try {
		const { target, run, identity, records } = coverageLaneFixture(root, hits);
		const expected = hits > 0 ? new Map([[1, 3], [2, 0]]) : new Map([[1, 0], [2, 0], [3, 0]]);
		for (const lanes of [records, [...records].reverse()]) {
			const plan = join(root, "plan.json");
			writeFileSync(plan, JSON.stringify({ matrix: { include: lanes.map(({ lane }) => ({ dir: lane, coverage: true })) } }));
			const result = readNativeCoverage({ root, directory: root, plan, run }, identity);
			expect(result.receipts.map(({ lane }) => lane)).toEqual(lanes.map(({ lane }) => lane));
			expect(result.lines.get(target)).toEqual(expected);
			expect(result.lines.get(target)?.get(2)).toBe(0);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage aggregation checks selected membership bytes run and script floor", () => {
	const root = mkdtempSync(join(tmpdir(), "quality-aggregate-"));
	const path = "script/a.ts", run = "native-run";
	const identity = { paths: [path], typescript: [path], inventoryHash: "a".repeat(64), contractHash: "b".repeat(64) };
	const lcov = "SF:a.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n";
	const receipt = {
		version: 1, complete: true, lane: "script", run, runtime: Bun.version,
		inventoryHash: identity.inventoryHash, lcovHash: digest(lcov), lcov,
		files: parseNativeLcov(lcov, "script"),
	};
	const plan = join(root, "plan.json");
	const options = { root, directory: root, plan, run };
	try {
		mkdirSync(join(root, "script"));
		writeFileSync(join(root, path), "export const a = 1;\nexport const b = 2;\n");
		writeFileSync(plan, JSON.stringify({ matrix: { include: [{ dir: "script", coverage: true }] } }));
		expect(() => readNativeCoverage(options, identity)).toThrow();
		writeFileSync(join(root, "script.json"), JSON.stringify(receipt));
		expect(readNativeCoverage(options, identity).lines.get(path)?.get(1)).toBe(1);
		for (const changed of [
			{ ...receipt, complete: false }, { ...receipt, run: "old" },
			{ ...receipt, inventoryHash: "c".repeat(64) }, { ...receipt, files: [] },
			{ ...receipt, lcovHash: "d".repeat(64) },
		]) {
			writeFileSync(join(root, "script.json"), JSON.stringify(changed));
			expect(() => readNativeCoverage(options, identity)).toThrow();
		}
		const partitions = ["scripts-contracts", "scripts-tooling-1", "scripts-tooling-2", "scripts-tooling-3", "scripts-tooling-4"];
		writeFileSync(plan, JSON.stringify({ version: 2, toolingTests: true, matrix: { include: partitions.slice(1).map((key) => ({ key, dir: "script", coverage: true })) } }));
		writeFileSync(join(root, "script.json"), JSON.stringify(receipt));
		expect(() => readNativeCoverage(options, identity)).toThrow();
		writeFileSync(join(root, "script.json"), JSON.stringify({ ...receipt, partitions }));
		expect(readNativeCoverage(options, identity).receipts).toHaveLength(1);
		const uncovered = lcov.replace("DA:1,1", "DA:1,0").replace("LH:1", "LH:0");
		writeFileSync(join(root, "script.json"), JSON.stringify({
			...receipt, lcov: uncovered, lcovHash: digest(uncovered), files: parseNativeLcov(uncovered, "script"),
		}));
		expect(() => readNativeCoverage(options, identity)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
