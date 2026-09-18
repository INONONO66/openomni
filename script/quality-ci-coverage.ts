import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeJson, digest, inventorySchema, jsonArray, jsonBoolean, jsonObject, jsonString } from "./quality-inventory";
import { recordObject } from "./quality-ci-input";
import { completeDocument, requireMeasurement, sameMembers, type Identity } from "./quality-ci-receipt";
import { mergeNativeLines, parseNativeLcov, type NativeLines } from "./quality-native-lcov";
import { coverageLanes } from "./topology";
import { scriptPartitions } from "./scripts-lanes";
import { type Coverage, mergeCoverage, type Prepared } from "./quality-metrics/coverage";
import { loadInventory } from "./quality-metrics/input";
import { exactArtifactPaths, exactCiPlan, exactCiShardPlan, exactCiShards, requireExactCiPlan } from "./quality-ci-exact";
import { decodeCoverage, type ExactShardPaths } from "./quality-ci-shard";

/** Verify one exact receipt in a child Bun process and admit only its merge
 * document, re-read by digest. Receipt verification of one shard is a gigabyte
 * class heap; keeping every shard's graph alive in the finish process made the
 * join exceed its job budget. Failure is a thrown InventoryError, never a
 * partial coverage. */
async function verifyOutOfProcess(paths: ExactShardPaths, scratch: string, shard: string): Promise<Coverage> {
	const out = join(scratch, `${shard}.json`);
	const argv = [process.execPath, resolve(import.meta.dir, "quality-ci-shard.ts"), "--root", paths.root, "--contract", paths.contract, "--inventory", paths.inventory, "--plan", paths.plan, "--coverage", paths.coverage, "--prepared", paths.prepared, "--out", out];
	const child = Bun.spawn(argv, { cwd: paths.root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	requireMeasurement(exitCode === 0, `exact shard ${shard} verification failed: ${stderr.trim()}`);
	const pointer = jsonObject(decodeJson(stdout), ["result", "resultSha256"]);
	const encoded = readFileSync(jsonString(pointer.result), "utf8");
	requireMeasurement(jsonString(pointer.result) === out && digest(encoded) === pointer.resultSha256, `exact shard ${shard} result digest differs`);
	return decodeCoverage(encoded);
}

async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => { for (let i = next++; i < items.length; i = next++) results[i] = await work(items[i] as T); };
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Shard verifications overlap only as far as the finish runner's memory
 * allows: one child verifying a 112 MB receipt peaked at 5.6 GB, and the
 * hosted runner has 16 GB. */
const EXACT_SHARD_CONCURRENCY = 2;

/** Consume the existing collector, not LCOV, for original statement evidence.
 * Its plan binds the CI run and selection before execution; its receipt binds
 * that plan, all original sources/maps and independently observed descendants.
 * Native lane/shard receipts below remain exclusively line-floor evidence. */
export async function readExactCoverage(options: {
	root: string; contract: string; directory: string; plan: string; run: string;
}, identity: Identity, prepared: Prepared[]): Promise<Coverage> {
	const { inventory: inventoryPath, fullPlan } = exactArtifactPaths(options.directory);
	for (const path of [inventoryPath, fullPlan]) requireMeasurement(existsSync(path), `missing exact statement evidence: ${path}`);
	const inventory = loadInventory(options.root, inventoryPath);
	requireMeasurement(inventory.inventoryHash === identity.inventoryHash && inventory.contractHash === identity.contractHash, "stale exact coverage inventory");
	const frozenPlan = recordObject(fullPlan), run = jsonObject(frozenPlan.run);
	requireMeasurement(run.id === options.run && run.selectionHash === digest(readFileSync(options.plan)), "stale exact coverage run or selection");
	const expected = exactCiPlan(options.root, options.contract, inventorySchema.parse(recordObject(inventoryPath)), options.plan, options.run);
	requireExactCiPlan(frozenPlan, expected);
	const scratch = mkdtempSync(join(tmpdir(), "exact-shard-")), preparedPath = join(scratch, "prepared.json");
	writeFileSync(preparedPath, JSON.stringify(prepared));
	try {
		const read = async (paths: ReturnType<typeof exactArtifactPaths>, shard: string) => {
			for (const path of [paths.plan, paths.coverage, `${paths.coverage}.sha256`]) requireMeasurement(existsSync(path), `missing exact statement evidence: ${path}`);
			return await verifyOutOfProcess({ root: options.root, contract: options.contract, inventory: inventoryPath, plan: paths.plan, coverage: paths.coverage, prepared: preparedPath }, scratch, shard);
		};
		// One whole receipt, or exactly the run's shards: every plan command once.
		const whole = exactArtifactPaths(options.directory);
		const shards = [...exactCiShards(expected).keys()].map((shard) => ({ shard, paths: exactArtifactPaths(options.directory, shard) }));
		if (!shards.some(({ paths }) => existsSync(paths.plan) || existsSync(paths.coverage))) return await read(whole, "whole");
		requireMeasurement(!existsSync(whole.coverage) && !existsSync(`${whole.coverage}.sha256`), "exact statement evidence is both whole and sharded");
		for (const { shard, paths } of shards) {
			requireMeasurement(existsSync(paths.plan), `missing exact statement evidence: ${paths.plan}`);
			requireExactCiPlan(recordObject(paths.plan), exactCiShardPlan(expected, shard));
		}
		const parts = await mapBounded(shards, EXACT_SHARD_CONCURRENCY, ({ shard, paths }) => read(paths, shard));
		return mergeCoverage(parts, digest(readFileSync(fullPlan)));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
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
