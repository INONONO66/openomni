import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, readDocument } from "./quality-ci-input";
import { parseStatic } from "./quality-ci-legs";
import { joinBounds, measureStatic } from "./quality-ci-metrics";
import { InventoryError, jsonArray, jsonObject, type Json } from "./quality-inventory";

test("static leg JSON is validated before joining instead of trusting an untyped payload", async () => {
	const root = mkdtempSync(join(tmpdir(), "quality-static-json-"));
	try {
		mkdirSync(join(root, "script"));
		writeFileSync(join(root, "script/a.ts"), "export const answer = 42;\n");
		writeFileSync(join(root, "script/tsconfig.json"), '{"include":["*.ts"]}');
		writeFileSync(join(root, "contract.json"), JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false }));
		const identity = fingerprint(root, "contract.json"), inventory = join(root, "inventory.json");
		writeFileSync(inventory, JSON.stringify(identity.inventory));
		const document = await measureStatic({ root, inventory });
		writeFileSync(join(root, "metrics.json"), JSON.stringify(document));
		const json = jsonObject(readDocument(join(root, "metrics.json")));
		expect(parseStatic(json)).toEqual(document);
		const patches: Record<string, Json>[] = [
			{ complete: false }, { version: 2 }, { measured: [] }, { hosts: [] }, { sources: [] }, { tools: [] },
			{ measured: [{ source: {}, analysis: {} }] },
			{ measured: jsonArray(json.measured, (entry) => ({ ...jsonObject(entry), analysis: { units: [], prepared: {}, receipt: null } })) },
			{ duplication: { ...jsonObject(json.duplication), inspected: "invalid" } },
			{ analyzerProcesses: jsonArray(json.analyzerProcesses, (entry) => ({ ...jsonObject(entry), transport: "invalid" })) },
			{ analyzerProcesses: jsonArray(json.analyzerProcesses, (entry) => ({ ...jsonObject(entry), pid: -1 })) },
			{ analyzerProcesses: jsonArray(json.analyzerProcesses, (entry) => ({ ...jsonObject(entry), exitCode: 2 })) },
		];
		for (const patch of patches) expect(() => parseStatic({ ...json, ...patch })).toThrow(InventoryError);
		expect(() => parseStatic(null)).toThrow(InventoryError);
		const joined = joinBounds(parseStatic(json), { identity, lines: new Map() });
		expect(joined.measurement.findings.some((row) => row.gate === "coverage")).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
