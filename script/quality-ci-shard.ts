import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { InventoryError, decodeJson, digest, jsonArray, jsonNumber, jsonObject, jsonString, type Json } from "./quality-inventory";
import { readDocument, recordObject } from "./quality-ci-input";
import { parsePrepared } from "./quality-ci-legs";
import { requireMeasurement } from "./quality-ci-receipt";
import { type Coverage, type Counters, loadCoverage } from "./quality-metrics/coverage";
import { loadInventory } from "./quality-metrics/input";

/** One exact receipt is verified in its own process. A receipt of one shard is
 * ~100 MB of JSON whose every process expands into observed lines, emitted
 * proofs and compiler emissions; verifying fourteen of them in one heap peaked
 * at 10 GB and outlived the finish step's job budget. The child returns only the small merge document below; the parent
 * re-reads it by digest and never parses receipt bytes itself. */
export type ExactShardPaths = { root: string; contract: string; inventory: string; plan: string; coverage: string; prepared: string };

export function verifyExactShard(paths: ExactShardPaths): Coverage {
	for (const path of [paths.plan, paths.coverage, `${paths.coverage}.sha256`]) requireMeasurement(existsSync(path), `missing exact statement evidence: ${path}`);
	const bytes = readFileSync(paths.coverage);
	requireMeasurement(readFileSync(`${paths.coverage}.sha256`, "utf8") === digest(bytes), "exact coverage bytes changed");
	const receipt = recordObject(paths.coverage);
	requireMeasurement(receipt.version === 1 && receipt.runtime === Bun.version, "exact collector runtime or receipt differs");
	const inventory = loadInventory(paths.root, paths.inventory), prepared = parsePrepared(readDocument(paths.prepared));
	return loadCoverage(paths.coverage, inventory, prepared, { root: paths.root, contract: paths.contract, inventory: paths.inventory, plan: paths.plan, scope: prepared.map((file) => file.path) });
}

export function encodeCoverage(coverage: Coverage): string {
	return JSON.stringify({ run: coverage.run, totals: [...coverage.totals.entries()], processes: coverage.processes, receiptHash: coverage.receiptHash });
}

function counters(value: Json | undefined): Counters {
	const object = jsonObject(value, ["s", "f"]);
	const record = (entry: Json | undefined) => Object.fromEntries(Object.entries(jsonObject(entry)).map(([id, n]) => [id, jsonNumber(n)]));
	return { s: record(object.s), f: record(object.f) };
}

export function decodeCoverage(text: string): Coverage {
	const document = jsonObject(decodeJson(text), ["run", "totals", "processes", "receiptHash"]);
	const run = jsonObject(document.run);
	const totals = new Map(jsonArray(document.totals, (entry) => {
		const pair = jsonArray(entry, (value) => value);
		if (pair.length !== 2) throw new InventoryError("schema", "", "expected totals pair");
		return [jsonString(pair[0]), counters(pair[1])] as const;
	}));
	const processes = jsonArray(document.processes, (entry) => {
		const process = jsonObject(entry, ["id", "parent", "children", "exitCode"]);
		return { id: jsonString(process.id), parent: jsonString(process.parent), children: jsonArray(process.children, jsonString), exitCode: process.exitCode === null ? null : jsonNumber(process.exitCode) };
	});
	const receiptHash = jsonString(document.receiptHash);
	if ("inventoryHash" in run) {
		jsonObject(run, ["id", "inventoryHash", "contractHash", "planHash"]);
		return { run: { id: jsonString(run.id), inventoryHash: jsonString(run.inventoryHash), contractHash: jsonString(run.contractHash), planHash: jsonString(run.planHash) }, totals, processes, receiptHash };
	}
	jsonObject(run, ["id", "head", "tree"]);
	return { run: { id: jsonString(run.id), head: jsonString(run.head), tree: jsonString(run.tree) }, totals, processes: processes.map((process) => ({ ...process, exitCode: jsonNumber(process.exitCode) })), receiptHash };
}

export function shardMain(argv: string[]): number {
	const { values } = parseArgs({ args: argv, options: { root: { type: "string" }, contract: { type: "string" }, inventory: { type: "string" }, plan: { type: "string" }, coverage: { type: "string" }, prepared: { type: "string" }, out: { type: "string" } } });
	const required = (key: keyof typeof values): string => {
		const value = values[key];
		if (typeof value !== "string" || value.length === 0) throw new InventoryError("measurement", "", `--${key} required`);
		return value;
	};
	const paths = { root: required("root"), contract: required("contract"), inventory: required("inventory"), plan: required("plan"), coverage: required("coverage"), prepared: required("prepared") }, out = required("out");
	const encoded = encodeCoverage(verifyExactShard(paths));
	writeFileSync(out, encoded, { flag: "wx" });
	process.stdout.write(`${JSON.stringify({ result: out, resultSha256: digest(encoded) })}\n`);
	return 0;
}

if (import.meta.main) {
	try { process.exitCode = shardMain(Bun.argv.slice(2)); } catch (error) {
		if (!(error instanceof InventoryError)) throw error;
		process.stderr.write(`${error.name} ${error.code} ${error.path}: ${error.message}\n`);
		process.exitCode = 2;
	}
}
