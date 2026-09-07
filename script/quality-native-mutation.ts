import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { digest, jsonArray, jsonChoice, jsonNumber, jsonObject, jsonString, type Json } from "./quality-inventory";
import { fingerprint } from "./quality-ci-input";
import { qualitySource } from "./quality-source";
import { completeDocument, mergeMeasurements, requireMeasurement, sameMembers, type Identity, type Measurement } from "./quality-ci-receipt";
import { nativeJson } from "./quality-native-process";
import { ratchetMain } from "./quality-ratchet";

export function normalizeMutation(value: Json, identity: Identity, root: string): Measurement {
	const row = completeDocument(value);
	requireMeasurement(row.version === 1 && row.full === true, "full mutation receipt required; pilot is not convergence");
	requireMeasurement(row.inventorySha256 === identity.inventoryHash, "stale mutation inventory");
	requireMeasurement(row.originalHashesVerified === true && row.cleanupVerified === true, "unverified mutation restoration");
	requireMeasurement(jsonArray(row.errors, jsonObject).length === 0, "mutation infrastructure errors");
	const results = jsonArray(row.results, jsonObject);
	requireMeasurement(results.length > 0, "empty mutation campaign");
	const census = jsonArray(row.census, jsonObject);
	const owned = [...identity.paths, ...(identity.embedded ?? []).map((source) => source.path)];
	sameMembers(census.map((source) => jsonString(source.path)).filter((path) => owned.includes(path)), owned);
	const candidates = census.flatMap((source) => jsonArray(source.operators, jsonObject))
		.reduce((total, operator) => total + jsonNumber(operator.candidates), 0);
	requireMeasurement(candidates === results.length, "missing enumerated mutation candidates");
	const counts = jsonObject(row.counts);
	for (const outcome of ["killed", "survived", "noCoverage", "invalid", "infrastructure", "uncompleted"])
		requireMeasurement(counts[outcome] === results.filter((result) => result.outcome === outcome).length, "mutation count mismatch");
	const findings = results.flatMap((result) => {
		requireMeasurement(result.selected === true && result.restored === true, "incomplete mutation candidate");
		const outcome = jsonChoice(result.outcome, ["killed", "survived", "noCoverage", "invalid"]);
		const sourcePath = jsonString(result.path);
		const virtual = identity.embedded?.find((entry) => entry.path === sourcePath);
		const path = virtual?.hostPath ?? sourcePath;
		if (!qualitySource(path)) return [];
		requireMeasurement(identity.paths.includes(path), "mutant outside source inventory");
		const source = virtual?.text ?? readFileSync(resolve(root, path), "utf8");
		requireMeasurement(result.sourceSha256 === digest(source), "stale mutant source");
		if (["killed", "invalid"].includes(outcome)) return [];
		const offset = jsonNumber(result.startOffset);
		requireMeasurement(Number.isSafeInteger(offset) && offset >= 0 && offset < source.length, "invalid mutation offset");
		return [{
			gate: "mutation" as const, path, line: (virtual?.lineOffset ?? 0) + source.slice(0, offset).split("\n").length,
			symbol: `${virtual ? "PYTHON_DRIVER:" : ""}${jsonString(result.operator)}:${jsonString(result.replacementSha256)}:${source.slice(offset, jsonNumber(result.endOffset))}`,
			value: 1,
		}];
	});
	return { analyzed: ["mutation"], findings };
}
export async function mutationMain(argv = Bun.argv.slice(2)): Promise<number> {
	const { values } = parseArgs({
		args: argv, strict: true, options: {
			root: { type: "string", default: process.cwd() },
			contract: { type: "string", default: "script/conformance/quality-contract.json" },
			decision: { type: "string", default: "script/conformance/quality-mutation-contract.json" },
			baseline: { type: "string" }, base: { type: "string", default: "origin/main" },
			output: { type: "string", default: "quality-mutation-results" },
		}
	});
	requireMeasurement(Boolean(values.baseline), "measured mutation baseline required");
	const root = resolve(values.root), directory = resolve(root, values.output);
	const identity = fingerprint(root, values.contract);
	mkdirSync(directory);
	const inventory = resolve(directory, "inventory.json");
	writeFileSync(inventory, JSON.stringify(identity.inventory), { flag: "wx" });
	const contract = resolve(root, values.contract), decision = resolve(root, values.decision);
	const inventoryTool = resolve(root, "script/quality-inventory.ts");
	const result = await nativeJson({
		cwd: root, timeout: 21_000_000, command: [
			process.execPath, resolve(root, "script/run-quality-mutations.ts"),
			"--root", root, "--contract", contract, "--contract-sha256", digest(readFileSync(contract)),
			"--inventory", inventory, "--inventory-sha256", identity.inventoryHash,
			"--decision", decision, "--decision-sha256", digest(readFileSync(decision)),
			"--inventory-tool", inventoryTool, "--inventory-tool-sha256", digest(readFileSync(inventoryTool)),
			"--dependencies", resolve(root, "node_modules"), "--python", process.env.D945_PYTHON ?? "python3",
			"--max-candidates", "1000000", "--budget", "20000000",
		]
	});
	writeFileSync(resolve(directory, "native.json"), JSON.stringify(result), { flag: "wx" });
	const measurement = normalizeMutation(result.document, identity, root);
	requireMeasurement(fingerprint(root, values.contract).inventoryHash === identity.inventoryHash, "sources changed during mutation");
	const current = resolve(directory, "current.json");
	writeFileSync(current, JSON.stringify(mergeMeasurements(identity.paths, [measurement])), { flag: "wx" });
	return ratchetMain(["--root", root, "--contract", contract, "--base", values.base,
		"--baseline", values.baseline ?? "", "--current", current]);
}
if (import.meta.main) process.exitCode = await mutationMain();
