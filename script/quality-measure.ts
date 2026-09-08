import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { digest, jsonChoice, jsonNumber, jsonObject } from "./quality-inventory";
import { fingerprint, readDocument, recordObject } from "./quality-ci-input";
import { normalizeTypes, normalizeCensus, mergeMeasurements, requireMeasurement, sameMembers } from "./quality-ci-receipt";
import { readNativeCoverage } from "./quality-ci-coverage";
import { joinBounds, measureStatic } from "./quality-ci-metrics";
import { parseStatic } from "./quality-ci-legs";
import { nativeJson } from "./quality-native-process";
import { qualitySchemas } from "./quality-schema";
import { baselineAt, carryUnmeasured, changedSources, ratchetMain } from "./quality-ratchet";
import { qualityPlan } from "./quality-plan";

const legs = ["types", "publisher", "export", "store", "metrics"] as const;
type Leg = typeof legs[number];

async function phase<T>(name: string, action: () => T | Promise<T>) {
	const started = performance.now();
	let durationMs = 0;
	let result: T;
	try {
		result = await action();
	} finally {
		durationMs = Math.round(performance.now() - started);
		console.error(`[quality-phase] name=${name} ms=${durationMs}`);
	}
	return { result, durationMs };
}
function save(directory: string, name: string, document: object) {
	const path = resolve(directory, `${name}.json`);
	writeFileSync(path, JSON.stringify(document), { flag: "wx" });
	return path;
}
async function collectLeg(root: string, contract: string, directory: string, leg: Leg, identity: ReturnType<typeof fingerprint>, scope: ReturnType<typeof qualityPlan>, plan?: string) {
	// Native census paths must stay inside root. Disposable inputs do not travel
	// with the leg, and concurrent collectors never share an inventory or schema.
	const temporary = mkdtempSync(resolve(root, `.quality-${leg}-`));
	try {
		const inventory = save(temporary, "inventory", identity.inventory);
		if (leg === "metrics") return await measureStatic({ root, inventory, ...(scope.whole ? {} : { scope: scope.paths }) });
		const common = ["--root", root, "--contract", relative(root, contract), "--inventory", relative(root, inventory), ...(plan ? ["--plan", resolve(root, plan)] : [])];
		const args = leg === "types" ? common : [...common, "--json", "--inventory-sha256", identity.inventoryHash, "--class", leg];
		if (leg === "export") {
			const knip = resolve(root, "node_modules/knip/bin/knip.js");
			args.push("--knip", knip, "--knip-sha256", digest(readFileSync(knip)));
		}
		if (leg === "store") {
			const schemas = qualitySchemas(root, temporary);
			args.push("--python", process.env.D945_PYTHON ?? "python3",
				"--schema", relative(root, schemas.fresh), "--schema-sha256", digest(readFileSync(schemas.fresh)),
				"--upgraded-schema", relative(root, schemas.upgraded), "--upgraded-schema-sha256", digest(readFileSync(schemas.upgraded)));
		}
		return await nativeJson({ cwd: root, receipt: resolve(directory, `${leg}.process.json`),
			command: [process.execPath, resolve(root, leg === "types" ? "script/check-types-census.ts" : "script/check-census.ts"), ...args] });
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
function admitLegs(root: string, contract: string, directory: string, plan: string) {
	const identity = fingerprint(root, contract);
	for (const leg of legs) {
		const path = resolve(directory, `${leg}.identity.json`);
		requireMeasurement(existsSync(path), `missing quality leg: ${leg}`);
		const row = recordObject(path);
		requireMeasurement(row.version === 1 && row.leg === leg && row.inventoryHash === identity.inventoryHash && row.contractHash === identity.contractHash, `stale quality leg: ${leg}`);
		const duration = jsonNumber(row.durationMs);
		requireMeasurement(Number.isSafeInteger(duration) && duration >= 0, `invalid quality leg duration: ${leg}`);
	}
	const scope = qualityPlan(root, contract, identity.inventory, plan);
	for (const leg of legs) {
		const row = recordObject(resolve(directory, `${leg}.identity.json`));
		requireMeasurement(row.scopeHash === (scope.whole ? undefined : scope.hash), `stale quality scope: ${leg}`);
	}
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) appendFileSync(summary, `| Quality leg | Phase | Seconds |\n| --- | --- | ---: |\n${legs.map((leg) => `| ${leg} | collect | ${(jsonNumber(recordObject(resolve(directory, `${leg}.identity.json`)).durationMs) / 1000).toFixed(3)} |`).join("\n")}\n`);
	return { identity, scope };
}

export async function measureMain(argv = Bun.argv.slice(2)): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv, strict: true, allowPositionals: true, options: {
			root: { type: "string", default: process.cwd() },
			contract: { type: "string", default: "script/conformance/quality-contract.json" },
			leg: { type: "string" }, legs: { type: "string" },
			baseline: { type: "string" }, base: { type: "string" }, output: { type: "string" },
			"coverage-directory": { type: "string" }, plan: { type: "string" }, run: { type: "string" },
		}
	});
	requireMeasurement(positionals.length === 1 && argv[0] === positionals[0] && (positionals[0] === "collect" || positionals[0] === "finish"), "expected collect or finish");
	const root = resolve(values.root), contract = resolve(root, values.contract);
	if (positionals[0] === "collect") {
		requireMeasurement(Boolean(values.leg && values.output), "collect requires leg and output");
		const leg = jsonChoice(values.leg, legs), directory = resolve(root, values.output ?? "");
		const collected = await phase(leg, async () => {
			const identity = fingerprint(root, contract);
			mkdirSync(directory, { recursive: true });
			const scope = qualityPlan(root, contract, identity.inventory, values.plan);
			save(directory, leg, await collectLeg(root, contract, directory, leg, identity, scope, values.plan));
			return { identity, scope };
		});
		const { identity, scope } = collected.result;
		save(directory, `${leg}.identity`, { version: 1, leg, inventoryHash: identity.inventoryHash, contractHash: identity.contractHash, durationMs: collected.durationMs, ...(scope.whole ? {} : { scopeHash: scope.hash }) });
		return 0;
	}
	requireMeasurement(Boolean(values.legs && values.base && values.baseline && values.plan && values.run && values["coverage-directory"]), "finish requires legs, base, baseline, plan, run and fresh coverage directory");
	const directory = resolve(root, values.output ?? "quality-results"), legDirectory = resolve(root, values.legs ?? "");
	const { identity, scope } = (await phase("fingerprint", () => admitLegs(root, contract, legDirectory, values.plan ?? ""))).result;
	const native = (leg: string) => jsonObject(readDocument(resolve(legDirectory, `${leg}.json`))).document;
	const types = normalizeTypes(native("types") ?? null, { ...identity, typescript: identity.typescript.filter((path) => scope.paths.includes(path)) });
	const census = (["publisher", "export", "store"] as const).map((leg) => normalizeCensus(native(leg) ?? null, identity, leg));
	const coverage = (await phase("coverage", () => readNativeCoverage({
		root, directory: resolve(root, values["coverage-directory"] ?? ""), plan: resolve(root, values.plan ?? ""), run: values.run ?? "",
	}, identity))).result;
	const selectedLanes = coverage.receipts.map((receipt) => receipt.lane);
	for (const path of changedSources(root, values.base ?? "")) {
		requireMeasurement(selectedLanes.some((lane) => path.startsWith(`${lane}/`)), `changed source has no selected coverage lane: ${path}`);
		requireMeasurement(scope.paths.includes(path), `changed source outside quality scope: ${path}`);
	}
	const joined = await phase("join", () => {
		const document = parseStatic(readDocument(resolve(legDirectory, "metrics.json")));
		sameMembers(document.measured.map((row) => row.source.path), [...identity.paths.filter((path) => scope.paths.includes(path)), ...identity.embedded.filter((row) => scope.paths.includes(row.hostPath)).map((row) => row.path)]);
		const metrics = joinBounds(document, { identity, lines: coverage.lines, selectedLanes });
		mkdirSync(directory);
		save(directory, "inventory", identity.inventory);
		save(directory, "metrics", metrics);
		save(directory, "coverage", { run: values.run, receipts: coverage.receipts });
		const measured = mergeMeasurements([...identity.paths, ...identity.schemaPaths], [types, ...census, metrics.measurement]);
		const current = save(directory, "current", scope.whole ? measured : carryUnmeasured(root, baselineAt(root, values.baseline ?? ""), measured, [...scope.paths, ...identity.schemaPaths], ["productionClones", "testClones"]));
		requireMeasurement(fingerprint(root, contract).inventoryHash === identity.inventoryHash, "sources changed during measurement");
		return current;
	});
	return (await phase("ratchet", () => ratchetMain(["--root", root, "--contract", contract, "--base", values.base ?? "",
		"--baseline", values.baseline ?? "", "--current", joined.result]))).result;
}
if (import.meta.main) process.exitCode = await measureMain();
