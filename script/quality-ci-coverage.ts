import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { digest, inventorySchema, jsonArray, jsonBoolean, jsonObject, jsonString } from "./quality-inventory";
import { recordObject } from "./quality-ci-input";
import { completeDocument, requireMeasurement, sameMembers, type Identity } from "./quality-ci-receipt";
import { mergeNativeLines, parseNativeLcov, type NativeLines } from "./quality-native-lcov";
import { coverageLanes } from "./topology";
import { scriptPartitions } from "./scripts-lanes";
import { loadCoverage, type Prepared } from "./quality-metrics/coverage";
import { loadInventory } from "./quality-metrics/input";
import { exactCiPlan, requireExactCiPlan } from "./quality-ci-exact";

/** Consume the existing collector, not LCOV, for original statement evidence.
 * Its plan binds the CI run and selection before execution; its receipt binds
 * that plan, all original sources/maps and independently observed descendants.
 * Native lane/shard receipts below remain exclusively line-floor evidence. */
export function readExactCoverage(options: {
	root: string; contract: string; directory: string; plan: string; run: string;
}, identity: Identity, prepared: Prepared[]) {
	const inventoryPath = resolve(options.directory, "exact.inventory.json");
	const plan = resolve(options.directory, "exact.plan.json");
	const coverage = resolve(options.directory, "exact.coverage.json");
	for (const path of [inventoryPath, plan, coverage, `${coverage}.sha256`])
		requireMeasurement(existsSync(path), `missing exact statement evidence: ${path}`);
	const inventory = loadInventory(options.root, inventoryPath);
	requireMeasurement(inventory.inventoryHash === identity.inventoryHash && inventory.contractHash === identity.contractHash, "stale exact coverage inventory");
	const frozenPlan = recordObject(plan), run = jsonObject(frozenPlan.run);
	requireMeasurement(run.id === options.run && run.selectionHash === digest(readFileSync(options.plan)), "stale exact coverage run or selection");
	if (frozenPlan.version === 3) requireExactCiPlan(frozenPlan, exactCiPlan(options.root, options.contract,
		inventorySchema.parse(recordObject(inventoryPath)), options.plan, options.run));
	const bytes = readFileSync(coverage);
	requireMeasurement(readFileSync(`${coverage}.sha256`, "utf8") === digest(bytes), "exact coverage bytes changed");
	const receipt = recordObject(coverage);
	requireMeasurement(receipt.version === 1 && receipt.runtime === Bun.version, "exact collector runtime or receipt differs");
	return loadCoverage(coverage, inventory, prepared, {
		root: options.root, contract: options.contract, inventory: inventoryPath, plan,
		scope: prepared.map((file) => file.path),
	});
}

function selectedLanes(plan: string): string[] {
	const document = recordObject(plan);
	const matrix = jsonObject(document.matrix);
	const lanes = jsonArray(matrix.include, (value) => {
		const row = jsonObject(value);
		return { dir: jsonString(row.dir), coverage: jsonBoolean(row.coverage) };
	}).filter((row) => row.coverage).map((row) => row.dir);
	requireMeasurement(lanes.length > 0, "no selected coverage lanes");
	for (const lane of lanes)
		requireMeasurement(coverageLanes().some((row) => row.dir === lane), "unknown selected coverage lane");
	if (document.version === 2 && document.toolingTests === true) {
		const partitions = jsonArray(matrix.include, jsonObject).filter((row) => row.dir === "script").map((row) => jsonString(row.key));
		sameMembers(partitions, scriptPartitions.filter((key) => key !== "scripts-contracts"));
		sameMembers(lanes.filter((lane) => lane !== "script"), [...new Set(lanes.filter((lane) => lane !== "script"))]);
	} else sameMembers(lanes, [...new Set(lanes)]);
	return [...new Set(lanes)];
}
function checkScriptFloor(files: NativeLines[]): void {
	const lines = files.filter((file) =>
		/^script\/[^/]+\.tsx?$/.test(file.path) && !/\.(test|spec)\.tsx?$/.test(file.path),
	).flatMap((file) => file.lines);
	requireMeasurement(lines.length > 0, "script coverage has no owned lines");
	const covered = lines.filter((row) => row.hits > 0).length;
	requireMeasurement(covered / lines.length * 100 >= 30.63, "script coverage below 30.63%");
}
export function readNativeCoverage(options: {
	root: string; directory: string; plan: string; run: string;
}, identity: Identity) {
	const receipts = selectedLanes(options.plan).map((lane) => {
		const path = resolve(options.directory, `${lane.replaceAll("/", "-")}.json`);
		const row = completeDocument(recordObject(path));
		requireMeasurement(row.version === 1 && row.run === options.run, "stale coverage run");
		requireMeasurement(row.lane === lane && row.inventoryHash === identity.inventoryHash, "stale coverage source inventory");
		requireMeasurement(row.runtime === Bun.version, "coverage runtime differs from measurement runtime");
		const lcov = jsonString(row.lcov);
		requireMeasurement(row.lcovHash === digest(lcov), "coverage bytes changed");
		const files = parseNativeLcov(lcov, lane);
		requireMeasurement(JSON.stringify(row.files) === JSON.stringify(files), "coverage line records changed");
		if (lane === "script") {
			if (recordObject(options.plan).toolingTests === true) sameMembers(jsonArray(row.partitions, jsonString), [...scriptPartitions]);
			checkScriptFloor(files);
		}
		return { lane, lcovHash: digest(lcov), files };
	});
	const lines = new Map<string, Map<number, number>>();
	for (const file of mergeNativeLines(receipts.flatMap((row) => row.files))) {
		if (!identity.paths.includes(file.path)) continue;
		const length = readFileSync(resolve(options.root, file.path), "utf8").split("\n").length;
		const counters = lines.get(file.path) ?? new Map<number, number>();
		for (const row of file.lines) {
			requireMeasurement(row.line <= length, "LCOV line outside original source");
			counters.set(row.line, row.hits);
		}
		lines.set(file.path, counters);
	}
	requireMeasurement(lines.size > 0, "no campaign source coverage");
	return { receipts, lines };
}
