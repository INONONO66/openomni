import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprint } from "./quality-ci-input";
import { measureBounds } from "./quality-ci-metrics";

test("real pinned analyzers produce labeled bounds and reject source drift", async () => {
	const root = mkdtempSync(join(tmpdir(), "quality-bound-native-"));
	try {
		mkdirSync(join(root, "script"));
		writeFileSync(join(root, "script/a.ts"), "export function answer(value: boolean): number {\n  if (value) return 1;\n  return 2;\n}\n");
		writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
		writeFileSync(join(root, "contract.json"), JSON.stringify({
			version: 1, typescript: "5.9.2", roots: ["script"],
			projects: ["script/tsconfig.json"], topology: false,
		}));
		const identity = fingerprint(root, "contract.json");
		const inventory = join(root, "inventory.json");
		writeFileSync(inventory, JSON.stringify(identity.inventory));
		const result = await measureBounds({ root, inventory, lines: new Map<string, ReadonlyMap<number, number>>() });
		expect(result.algorithm).toBe("d945-lcov-crap-upper-bound@1");
		expect(result.complete).toBe(true);
		const answer = result.records.find((row) => row.name === "answer");
		expect(answer?.cyclomatic).toBe(2);
		expect(answer?.crap).toBe(6);
		expect(result.measurement.analyzed).toContain("coverage");
		expect(result.measurement.findings.some((row) => row.gate === "coverage")).toBe(true);
		expect(result.duplication.inspected).toHaveLength(1);
		const unselected = await measureBounds({ root, inventory, lines: new Map<string, ReadonlyMap<number, number>>(), selectedLanes: ["apps/unrelated"] });
		expect(unselected.coverageScope).toEqual(["apps/unrelated"]);
		expect(unselected.measurement.findings.some((row) => row.gate === "coverage" || row.gate === "crap")).toBe(false);
		expect(unselected.records.map((row) => row.cyclomatic)).toEqual(result.records.map((row) => row.cyclomatic));
		writeFileSync(join(root, "script/a.ts"), "export const changed = 1;\n");
		await expect(measureBounds({ root, inventory, lines: new Map<string, ReadonlyMap<number, number>>() })).rejects.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
