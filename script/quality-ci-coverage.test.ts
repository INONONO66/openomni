import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeCoverage } from "./quality-ci-coverage";
import { digest } from "./quality-inventory";
import { parseNativeLcov } from "./quality-native-lcov";

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
		const uncovered = lcov.replace("DA:1,1", "DA:1,0").replace("LH:1", "LH:0");
		writeFileSync(join(root, "script.json"), JSON.stringify({
			...receipt, lcov: uncovered, lcovHash: digest(uncovered), files: parseNativeLcov(uncovered, "script"),
		}));
		expect(() => readNativeCoverage(options, identity)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
