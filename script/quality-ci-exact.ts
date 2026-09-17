import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { decodeJson, digest, jsonArray, jsonBoolean, jsonLiteral, jsonObject, jsonString, type Inventory } from "./quality-inventory";
import { fingerprint, recordObject } from "./quality-ci-input";
import { completeDocument, requireMeasurement, sameMembers } from "./quality-ci-receipt";
import { nativeJson } from "./quality-native-process";
import { qualityPlan } from "./quality-plan";
import { scriptContracts, scriptPartitions, scriptTests, scriptToolingPartitions } from "./scripts-lanes";
import { TOPOLOGY } from "./topology";

type ExactCommand = { id: string; kind: "test" | "cli"; paths: string[]; args: string[]; cwd: string; runtime: "bun" | "python"; expectedExitCode: number };
function workspaceTests(root: string, cwd: string, inventory: Inventory): string[] {
	const config = resolve(root, cwd, "bunfig.toml");
	const test = existsSync(config) ? jsonObject(jsonObject(decodeJson(JSON.stringify(Bun.TOML.parse(readFileSync(config, "utf8"))))).test ?? {}) : {};
	// A new discovery root needs an explicit adapter contract, not guessed paths.
	requireMeasurement(test.root === undefined && test.preload === undefined, "unsupported exact CI test discovery root or preload");
	const ignored = test.pathIgnorePatterns === undefined ? [] : jsonArray(test.pathIgnorePatterns, jsonString).map((pattern) => new Bun.Glob(pattern));
	return inventory.files.filter((file) => file.path.startsWith(`${cwd}/`) && /[._](test|spec)\.[cm]?[jt]sx?$/.test(file.path) &&
		!ignored.some((pattern) => pattern.match(relative(cwd, file.path)))).map((file) => file.path).sort();
}

/** Shared derivation, independently invoked by producer and finish. Selection
 * binds commands, not execution credit: unselected modules can still be loaded. */
export function exactCiPlan(root: string, contract: string, inventory: Inventory, path: string, run: string) {
	qualityPlan(root, contract, inventory, path);
	const selection = recordObject(path);
	jsonLiteral(selection.version, 2);
	requireMeasurement(jsonBoolean(selection.verify) && run.length > 0, "exact CI collection requires a verifying run");
	const tooling = jsonBoolean(selection.toolingTests);
	const lanes = jsonArray(jsonObject(selection.matrix).include, (value) => {
		const row = jsonObject(value);
		return { key: jsonString(row.key), dir: jsonString(row.dir), coverage: jsonBoolean(row.coverage) };
	});
	sameMembers(lanes.map((lane) => lane.key), [...new Set(lanes.map((lane) => lane.key))]);
	sameMembers(lanes.filter((lane) => lane.dir === "script").map((lane) => lane.key), tooling ? scriptPartitions.filter((key) => key !== "scripts-contracts") : []);
	const contracts = scriptTests("scripts-contracts", inventory.files.filter((file) => file.path.startsWith("script/") && file.path.endsWith(".test.ts")).map((file) => file.path.slice("script/".length)));
	const commands: ExactCommand[] = [];
	const add = (id: string, cwd: string, paths: readonly string[], kind: "test" | "cli" = "test", args: readonly string[] = [], runtime: "bun" | "python" = "bun") => {
		requireMeasurement(paths.length > 0 && paths.every((path) => inventory.files.some((file) => file.path === path)), `exact CI command outside inventory: ${id}`);
		commands.push({ id, kind, paths: [...paths], args: [...args], cwd, runtime, expectedExitCode: 0 });
	};
	for (const lane of lanes) {
		if (lane.dir === "script") {
			requireMeasurement(lane.coverage, "script exact CI lane must own coverage");
			const partition = Object.entries(scriptToolingPartitions).find(([key]) => key === lane.key);
			requireMeasurement(Boolean(partition), "unknown exact CI script partition");
			add(lane.key, "script", (partition?.[1] ?? []).map((path) => `script/${path}`));
		} else {
			requireMeasurement(TOPOLOGY.some((workspace) => workspace.key === lane.key && workspace.dir === lane.dir && workspace.coverageLane === lane.coverage), "unknown exact CI workspace");
			add(lane.key, lane.dir, workspaceTests(root, lane.dir, inventory));
		}
	}
	// These run on every CI plan, independently of the tooling matrix.
	add("scripts-contracts", "script", contracts.map((path) => `script/${path}`));
	for (const [index, [entry, ...args]] of scriptContracts.entries()) add(`script-contract-${index}`, ".", [`script/${entry}`], "cli", args);
	if (tooling) for (const [index, file] of inventory.files.filter((file) => /^script\/quality-coverage\/test_.*\.py$/.test(file.path) || file.path === "script/quality-mutation/python-engine.test.py").entries())
		add(`python-${index}`, ".", [file.path], "cli", [], "python");
	return { version: 3, commands, run: { id: run, selectionHash: digest(readFileSync(path)) } };
}

export type ExactPlan = ReturnType<typeof exactCiPlan>;
/** One shard per selected matrix lane; contracts, CLI self-tests and Python
 * tests share the `scripts-contracts` shard. Every command has one shard. */
export function exactCiShards(plan: ExactPlan): Map<string, string[]> {
	const shards = new Map<string, string[]>([["scripts-contracts", []]]);
	for (const command of plan.commands) {
		const shard = command.kind === "test" && command.id !== "scripts-contracts" ? command.id : "scripts-contracts";
		shards.set(shard, [...(shards.get(shard) ?? []), command.id]);
	}
	return shards;
}
export function exactCiShardPlan(plan: ExactPlan, shard: string): ExactPlan {
	const ids = exactCiShards(plan).get(shard);
	requireMeasurement(ids !== undefined, `unknown exact CI shard: ${shard}`);
	return { ...plan, commands: plan.commands.filter((command) => ids?.includes(command.id)) };
}

export function requireExactCiPlan(actual: ReturnType<typeof recordObject>, expected: ReturnType<typeof exactCiPlan>): void {
	// Compare parsed machine fields, not object key ordering or a claimed hash.
	sameMembers(Object.keys(actual), Object.keys(expected));
	const run = jsonObject(actual.run);
	sameMembers(Object.keys(run), Object.keys(expected.run));
	requireMeasurement(actual.version === 3 && run.id === expected.run.id && run.selectionHash === expected.run.selectionHash, "stale exact CI run or selection");
	const commands = jsonArray(actual.commands, jsonObject);
	requireMeasurement(commands.length === expected.commands.length, "exact CI command selection differs");
	for (const [index, command] of expected.commands.entries()) {
		const row = commands[index] ?? {};
		sameMembers(Object.keys(row), Object.keys(command));
		const fields = jsonObject(decodeJson(JSON.stringify(command)));
		for (const key of Object.keys(row)) requireMeasurement(JSON.stringify(row[key]) === JSON.stringify(fields[key]), `exact CI command differs: ${command.id}/${key}`);
	}
}

/** Real collector only. Exit 1 is complete uncovered evidence, never a passing
 * quality verdict. Failure leaves frozen inputs/native diagnostics, no seal. */
function freeze(path: string, bytes: string): void {
	// Shards of one run share the frozen inventory and full plan byte for byte.
	if (existsSync(path)) requireMeasurement(readFileSync(path, "utf8") === bytes, `frozen exact CI input differs: ${path}`);
	else writeFileSync(path, bytes, { flag: "wx" });
}
export function exactArtifactPaths(directory: string, shard?: string) {
	const name = shard === undefined ? "exact" : `exact.${shard}`;
	return { inventory: resolve(directory, "exact.inventory.json"), fullPlan: resolve(directory, "exact.plan.json"), plan: resolve(directory, `${name}.plan.json`),
		coverage: resolve(directory, `${name}.coverage.json`), verdict: resolve(directory, `${name}.result.json`), receipt: resolve(directory, `${name}.process.json`) };
}
export async function collectExactCi(options: { root: string; contract: string; directory: string; plan: string; run: string; shard?: string }): Promise<number> {
	const root = realpathSync(options.root), contract = resolve(root, options.contract), selection = resolve(root, options.plan);
	const identity = fingerprint(root, contract), full = exactCiPlan(root, contract, identity.inventory, selection, options.run);
	const plan = options.shard === undefined ? full : exactCiShardPlan(full, options.shard);
	mkdirSync(options.directory, { recursive: true });
	const { inventory: inventoryPath, fullPlan, plan: planPath, coverage, verdict, receipt } = exactArtifactPaths(options.directory, options.shard);
	requireMeasurement(!existsSync(coverage) && !existsSync(`${coverage}.sha256`) && !existsSync(verdict), "exact collection requires fresh output");
	freeze(inventoryPath, JSON.stringify(identity.inventory));
	freeze(fullPlan, JSON.stringify(full));
	if (options.shard !== undefined) writeFileSync(planPath, JSON.stringify(plan), { flag: "wx" });
	const paths = { contract, inventory: inventoryPath, plan: planPath };
	const result = await nativeJson({ cwd: root, receipt, onStderr: (chunk) => { process.stderr.write(chunk); }, command: [process.execPath, resolve(import.meta.dir, "check-quality-coverage.ts"), "--root", root,
		...Object.entries(paths).flatMap(([key, path]) => [`--${key}`, path, `--${key}-sha256`, digest(readFileSync(path))]), "--collect", "--write-coverage", coverage, "--write-result", verdict] });
	const document = completeDocument(result.document);
	requireMeasurement(document.exitCode === result.exitCode, "exact collector status differs from result");
	// The pointer on stdout is small; the verdict bytes it names must be the complete document.
	requireMeasurement(document.result === verdict && existsSync(verdict) && document.resultSha256 === digest(readFileSync(verdict)), "exact collector verdict differs from its receipt");
	requireMeasurement(completeDocument(decodeJson(readFileSync(verdict, "utf8"))).exitCode === result.exitCode, "exact collector verdict status differs");
	requireMeasurement(fingerprint(root, contract).inventoryHash === identity.inventoryHash, "sources changed during exact collection");
	const expected = exactCiPlan(root, contract, identity.inventory, selection, options.run);
	requireExactCiPlan(recordObject(planPath), options.shard === undefined ? expected : exactCiShardPlan(expected, options.shard));
	writeFileSync(`${coverage}.sha256`, digest(readFileSync(coverage)), { flag: "wx" });
	return result.exitCode;
}
