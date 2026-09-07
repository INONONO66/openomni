import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { digest } from "./quality-inventory";
import { fingerprint } from "./quality-ci-input";
import { normalizeTypes, normalizeCensus, mergeMeasurements, requireMeasurement } from "./quality-ci-receipt";
import { readNativeCoverage } from "./quality-ci-coverage";
import { measureBounds } from "./quality-ci-metrics";
import { nativeJson } from "./quality-native-process";
import { qualitySchemas } from "./quality-schema";
import { changedSources, ratchetMain } from "./quality-ratchet";

export async function measureMain(argv = Bun.argv.slice(2)): Promise<number> {
	const { values } = parseArgs({
		args: argv, strict: true, options: {
			root: { type: "string", default: process.cwd() },
			contract: { type: "string", default: "script/conformance/quality-contract.json" },
			baseline: { type: "string" }, base: { type: "string", default: "origin/main" },
			output: { type: "string", default: "quality-results" },
			"coverage-directory": { type: "string" }, plan: { type: "string" }, run: { type: "string" },
		}
	});
	requireMeasurement(Boolean(values.baseline && values.plan && values.run && values["coverage-directory"]), "baseline, plan, run and fresh coverage directory required");
	const root = resolve(values.root), directory = resolve(root, values.output);
	const identity = fingerprint(root, values.contract);
	const coverage = readNativeCoverage({
		root, directory: resolve(root, values["coverage-directory"] ?? ""),
		plan: resolve(root, values.plan ?? ""), run: values.run ?? "",
	}, identity);
	const selectedLanes = coverage.receipts.map((receipt) => receipt.lane);
	for (const path of changedSources(root, values.base)) {
		requireMeasurement(selectedLanes.some((lane) => path.startsWith(`${lane}/`)), `changed source has no selected coverage lane: ${path}`);
	}
	mkdirSync(directory);
	const save = (name: string, text: string) => {
		const path = resolve(directory, `${name}.json`);
		writeFileSync(path, text, { flag: "wx" });
		return path;
	};
	const inventory = save("inventory", JSON.stringify(identity.inventory));
	const contract = resolve(root, values.contract);
	const common = ["--root", root, "--contract", relative(root, contract), "--inventory", relative(root, inventory)];
	const collect = async (name: string, script: string, args: string[]) => {
		const result = await nativeJson({ cwd: root, receipt: resolve(directory, `${name}.process.json`), command: [process.execPath, resolve(root, script), ...args] });
		save(name, JSON.stringify(result));
		return result.document;
	};
	const types = normalizeTypes(await collect("types", "script/check-types-census.ts", common), identity);
	const schemas = qualitySchemas(root, directory);
	const knip = resolve(root, "node_modules/knip/bin/knip.js");
	const censusArgs = [...common, "--json", "--inventory-sha256", identity.inventoryHash];
	const publisher = normalizeCensus(await collect("publisher", "script/check-census.ts",
		[...censusArgs, "--class", "publisher"]), identity, "publisher");
	const exports = normalizeCensus(await collect("export", "script/check-census.ts",
		[...censusArgs, "--class", "export", "--knip", knip, "--knip-sha256", digest(readFileSync(knip))]), identity, "export");
	const stores = normalizeCensus(await collect("store", "script/check-census.ts", [
		...censusArgs, "--class", "store", "--python", process.env.D945_PYTHON ?? "python3",
		"--schema", relative(root, schemas.fresh), "--schema-sha256", digest(readFileSync(schemas.fresh)),
		"--upgraded-schema", relative(root, schemas.upgraded), "--upgraded-schema-sha256", digest(readFileSync(schemas.upgraded)),
	]), identity, "store");
	const metrics = await measureBounds({ root, inventory, lines: coverage.lines, selectedLanes });
	save("metrics", JSON.stringify(metrics));
	save("coverage", JSON.stringify({ run: values.run, receipts: coverage.receipts }));
	requireMeasurement(fingerprint(root, values.contract).inventoryHash === identity.inventoryHash, "sources changed during measurement");
	const current = save("current", JSON.stringify(mergeMeasurements([...identity.paths, ...identity.schemaPaths], [
		types, publisher, exports, stores, metrics.measurement,
	])));
	return ratchetMain(["--root", root, "--contract", contract, "--base", values.base,
		"--baseline", values.baseline ?? "", "--current", current]);
}
if (import.meta.main) process.exitCode = await measureMain();
