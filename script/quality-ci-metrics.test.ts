import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprint, readDocument } from "./quality-ci-input";
import { joinBounds, measureStatic } from "./quality-ci-metrics";
import { parseStatic } from "./quality-ci-legs";
import { InventoryError } from "./quality-inventory";

test("static pinned analyzers survive JSON transfer and join conservative bounds", async () => {
	const root = mkdtempSync(join(tmpdir(), "quality-bound-native-"));
	try {
		mkdirSync(join(root, "script"));
		writeFileSync(join(root, "script/a.ts"), "export function answer(value: boolean): number {\n  if (value) return 1;\n  return 2;\n}\nexport function branching(a: boolean, b: boolean, c: boolean, d: boolean): number {\n  if (a) return 1;\n  if (b) return 2;\n  if (c) return 3;\n  if (d) return 4;\n  return 5;\n}\n");
		writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
		writeFileSync(join(root, "contract.json"), JSON.stringify({
			version: 1, typescript: "5.9.2", roots: ["script"],
			projects: ["script/tsconfig.json"], topology: false,
		}));
		const identity = fingerprint(root, "contract.json");
		const inventory = join(root, "inventory.json");
		writeFileSync(inventory, JSON.stringify(identity.inventory));
		const collected = await measureStatic({ root, inventory });
		writeFileSync(join(root, "static.json"), JSON.stringify(collected));
		const document = parseStatic(readDocument(join(root, "static.json")));
		expect(document).toEqual(collected);
		expect(document.analyzerProcesses.map((row) => row.operation)).toEqual(["javascript", "coverage", "clones"]);
		expect(document.analyzerProcesses.map((row) => row.transport)).toEqual(["in-process", "in-process", "process"]);
		for (const row of document.analyzerProcesses.slice(0, 2)) {
			expect(row.pid).toBeUndefined();
			expect(row.exitCode).toBeUndefined();
		}
		expect(document.analyzerProcesses[2]?.pid).toBeGreaterThan(0);
		expect(document.analyzerProcesses[2]?.exitCode).toBe(0);
		expect(document.pythonProcesses).toEqual([]);
		expect(document.sources).toEqual(identity.inventory.files.map(({ path, sha256 }) => ({ path, sha256 })));
		const lines = new Map<string, ReadonlyMap<number, number>>();
		const result = joinBounds(document, { identity, lines });
		expect(result.algorithm).toBe("d945-lcov-crap-upper-bound@1");
		expect(result.complete).toBe(true);
		const answer = result.records.find((row) => row.name === "answer");
		expect(answer).toMatchObject({ cyclomatic: 2, crap: 6 });
		expect(result.measurement.findings.find((row) => row.gate === "crap")).toMatchObject({ path: "script/a.ts", line: 5, endLine: 11, symbol: "FunctionDeclaration:branching", value: 30 });
		expect(result.measurement.analyzed).toContain("coverage");
		expect(result.measurement.findings.some((row) => row.gate === "coverage")).toBe(true);
		expect(result.duplication.inspected).toHaveLength(1);
		const unselected = joinBounds(document, { identity, lines, selectedLanes: ["apps/unrelated"] });
		expect(unselected.coverageScope).toEqual(["apps/unrelated"]);
		expect(unselected.measurement.findings.some((row) => row.gate === "coverage" || row.gate === "crap")).toBe(false);
		expect(unselected.records.map((row) => row.cyclomatic)).toEqual(result.records.map((row) => row.cyclomatic));
		const covered = joinBounds(document, { identity, lines: new Map([["script/a.ts", new Map([[2, 1], [3, 1]])]]), selectedLanes: ["script"] });
		expect(covered.records.find((row) => row.name === "answer")?.crap).toBeLessThan(6);
		for (const changed of [{ ...document, inventoryHash: "stale" }, { ...document, contractHash: "stale" }, { ...document, complete: false }, { ...document, version: 2 }]) {
			expect(() => joinBounds(changed, { identity, lines })).toThrow(InventoryError);
		}
		writeFileSync(join(root, "script/a.ts"), "export const changed = 1;\n");
		expect(() => joinBounds(document, { identity: fingerprint(root, "contract.json"), lines })).toThrow(InventoryError);
		await expect(measureStatic({ root, inventory })).rejects.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
