import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeCoverage } from "./quality-ci-coverage";
import { digest } from "./quality-inventory";
import { parseNativeLcov } from "./quality-native-lcov";

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
		const target = "packages/machines/src/a.ts", anchor = "script/anchor.ts", run = "native-run";
		const identity = { paths: [target, anchor], typescript: [target, anchor], inventoryHash: "a".repeat(64), contractHash: "b".repeat(64) };
		mkdirSync(join(root, "packages/machines/src"), { recursive: true }); mkdirSync(join(root, "script"));
		writeFileSync(join(root, target), "export const loaded = 1;\nexport const missing = () => 2;\n// artifact\n");
		writeFileSync(join(root, anchor), "export const anchor = 1;\n");
		const make = (lane: string, lcov: string) => ({ version: 1, complete: true, lane, run, runtime: Bun.version, inventoryHash: identity.inventoryHash, lcovHash: digest(lcov), lcov, files: parseNativeLcov(lcov, lane) });
		const records = [
			make("packages/machines", `SF:src/a.ts\nDA:1,${hits}\nDA:2,0\nLF:2\nLH:${hits > 0 ? 1 : 0}\nend_of_record\n`),
			make("script", "SF:anchor.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\nSF:../packages/machines/src/a.ts\nDA:1,0\nDA:3,0\nLF:2\nLH:0\nend_of_record\n"),
		];
		for (const row of records) writeFileSync(join(root, `${row.lane.replaceAll("/", "-")}.json`), JSON.stringify(row));
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
		const partitions = ["scripts-contracts", "scripts-tooling-1", "scripts-tooling-2", "scripts-tooling-3"];
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
