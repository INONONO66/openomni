import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { digest, jsonArray, jsonBoolean, jsonObject, jsonString } from "./quality-inventory";
import { recordObject } from "./quality-ci-input";
import { completeDocument, requireMeasurement, sameMembers, type Identity } from "./quality-ci-receipt";
import { parseNativeLcov, type NativeLines } from "./quality-native-lcov";
import { coverageLanes } from "./topology";

function selectedLanes(plan: string): string[] {
	const matrix = jsonObject(recordObject(plan).matrix);
	const lanes = jsonArray(matrix.include, (value) => {
		const row = jsonObject(value);
		return { dir: jsonString(row.dir), coverage: jsonBoolean(row.coverage) };
	}).filter((row) => row.coverage).map((row) => row.dir);
	requireMeasurement(lanes.length > 0, "no selected coverage lanes");
	for (const lane of lanes)
		requireMeasurement(coverageLanes().some((row) => row.dir === lane), "unknown selected coverage lane");
	sameMembers(lanes, [...new Set(lanes)]);
	return lanes;
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
		if (lane === "script") checkScriptFloor(files);
		return { lane, lcovHash: digest(lcov), files };
	});
	const lines = new Map<string, Map<number, number>>();
	for (const file of receipts.flatMap((row) => row.files)) {
		if (!identity.paths.includes(file.path)) continue;
		const length = readFileSync(resolve(options.root, file.path), "utf8").split("\n").length;
		const counters = lines.get(file.path) ?? new Map<number, number>();
		for (const row of file.lines) {
			requireMeasurement(row.line <= length, "LCOV line outside original source");
			counters.set(row.line, Math.max(counters.get(row.line) ?? 0, row.hits));
		}
		lines.set(file.path, counters);
	}
	requireMeasurement(lines.size > 0, "no campaign source coverage");
	return { receipts, lines };
}
