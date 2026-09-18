import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decodeJson, digest, jsonArray, jsonBoolean, jsonChoice, jsonLiteral, jsonObject, jsonString, type Inventory, type Json } from "./quality-inventory";
import { fingerprint, recordObject } from "./quality-ci-input";
import { completeDocument, requireMeasurement, sameMembers } from "./quality-ci-receipt";
import { nativeJson } from "./quality-native-process";
import { qualityPlan } from "./quality-plan";
import { scriptContracts, scriptPartitions, scriptTests, scriptToolingPartitions } from "./scripts-lanes";
import { TOPOLOGY, type WorkspaceTopology } from "./topology";

function workspaceTests(root: string, cwd: string, inventory: Inventory): string[] {
	const config = resolve(root, cwd, "bunfig.toml");
	const test = existsSync(config) ? jsonObject(jsonObject(decodeJson(JSON.stringify(Bun.TOML.parse(readFileSync(config, "utf8"))))).test ?? {}) : {};
	// A new discovery root needs an explicit adapter contract, not guessed paths.
	requireMeasurement(test.root === undefined && test.preload === undefined, "unsupported exact CI test discovery root or preload");
	const ignored = test.pathIgnorePatterns === undefined ? [] : jsonArray(test.pathIgnorePatterns, jsonString).map((pattern) => new Bun.Glob(pattern));
	return inventory.files.filter((file) => file.path.startsWith(`${cwd}/`) && /[._](test|spec)\.[cm]?[jt]sx?$/.test(file.path) &&
		!ignored.some((pattern) => pattern.match(relative(cwd, file.path)))).map((file) => file.path).sort();
}

export type ExactCommand = { id: string; kind: "test" | "cli"; paths: string[]; args: string[]; cwd: string; runtime: "bun" | "python"; expectedExitCode: number };
/** Producer derivation: the plan job embeds these commands into the CI
 * selection (`exact.commands`), whose bytes every exact receipt binds through
 * `run.selectionHash`. Selection binds commands, not execution credit:
 * unselected modules can still be loaded. */
export function exactCiCommands(root: string, inventory: Inventory, selection: {
	toolingTests: boolean; matrix: { include: readonly { key: string; dir: string; coverage: boolean }[] };
}, topology: readonly Pick<WorkspaceTopology, "key" | "dir" | "coverageLane">[] = TOPOLOGY): ExactCommand[] {
	const lanes = selection.matrix.include;
	sameMembers(lanes.map((lane) => lane.key), [...new Set(lanes.map((lane) => lane.key))]);
	sameMembers(lanes.filter((lane) => lane.dir === "script").map((lane) => lane.key), selection.toolingTests ? scriptPartitions.filter((key) => key !== "scripts-contracts") : []);
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
			requireMeasurement(topology.some((workspace) => workspace.key === lane.key && workspace.dir === lane.dir && workspace.coverageLane === lane.coverage), "unknown exact CI workspace");
			add(lane.key, lane.dir, workspaceTests(root, lane.dir, inventory));
		}
	}
	// These run on every CI plan, independently of the tooling matrix.
	add("scripts-contracts", "script", contracts.map((path) => `script/${path}`));
	for (const [index, [entry, ...args]] of scriptContracts.entries()) add(`script-contract-${index}`, ".", [`script/${entry}`], "cli", args);
	// Python test files are not exact commands: every one spawns interpreters and
	// the Python runner refuses process creation as unobservable (python.py
	// PROCESS_EVENTS). Their sources stay in the inventory as uncovered evidence
	// until the runner observes children the way the Bun collector does.
	return commands;
}

function selectionLanes(selection: Record<string, Json>) {
	const include = jsonArray(jsonObject(selection.matrix).include, (value) => {
		const row = jsonObject(value);
		return { key: jsonString(row.key), dir: jsonString(row.dir), coverage: jsonBoolean(row.coverage) };
	});
	return { toolingTests: jsonBoolean(selection.toolingTests), matrix: { include } };
}

/** Plan-job entry: embeds the derived commands into the selection file whose
 * bytes every exact receipt binds. A selection that already carries commands
 * is refused rather than overwritten. */
export function embedExactCommands(root: string, contract: string, path: string): void {
	const selection = recordObject(path);
	jsonLiteral(selection.version, 2);
	requireMeasurement(selection.exact === undefined, "selection already carries exact commands");
	const commands = jsonBoolean(selection.verify) ? exactCiCommands(root, fingerprint(root, contract).inventory, selectionLanes(selection)) : [];
	writeFileSync(path, JSON.stringify({ ...selection, exact: { derived: true, commands } }));
}

/** Consumer side, shared by the shard adapter and finish: the exact plan is
 * the selection's embedded commands, never a frozen-plan-authored list. Every
 * command must name inventory paths; there is no version that skips this. */
export function exactCiPlan(root: string, contract: string, inventory: Inventory, path: string, run: string) {
	qualityPlan(root, contract, inventory, path);
	const selection = recordObject(path);
	jsonLiteral(selection.version, 2);
	requireMeasurement(jsonBoolean(selection.verify) && run.length > 0, "exact CI collection requires a verifying run");
	const exact = jsonObject(selection.exact);
	const commands = jsonArray(exact.commands, (value): ExactCommand => {
		const row = jsonObject(value);
		sameMembers(Object.keys(row), ["id", "kind", "paths", "args", "cwd", "runtime", "expectedExitCode"]);
		const paths = jsonArray(row.paths, jsonString);
		const id = jsonString(row.id);
		requireMeasurement(paths.length > 0 && paths.every((path) => inventory.files.some((file) => file.path === path)), `exact CI command outside inventory: ${id}`);
		jsonLiteral(row.expectedExitCode, 0);
		return { id, kind: jsonChoice(row.kind, ["test", "cli"]), paths, args: jsonArray(row.args, jsonString), cwd: jsonString(row.cwd), runtime: jsonChoice(row.runtime, ["bun", "python"]), expectedExitCode: 0 };
	});
	sameMembers(commands.map((command) => command.id), [...new Set(commands.map((command) => command.id))]);
	// A selection that declares topology-derived commands is re-derived here
	// against this checkout, so lane ownership or test discovery drift between
	// the plan job and the consumer is rejected rather than trusted.
	if (jsonBoolean(exact.derived)) {
		const derived = exactCiCommands(root, inventory, selectionLanes(selection));
		requireMeasurement(JSON.stringify(derived) === JSON.stringify(commands), "exact CI commands differ from this checkout's derivation");
	}
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

export function embedExactMain(argv = Bun.argv.slice(2)): void {
	const { values } = parseArgs({ args: argv, strict: true, options: {
		root: { type: "string", default: process.cwd() }, contract: { type: "string", default: "script/conformance/quality-contract.json" }, plan: { type: "string" },
	} });
	requireMeasurement(Boolean(values.plan), "embedding exact commands requires --plan");
	embedExactCommands(resolve(values.root), values.contract, resolve(values.root, values.plan ?? ""));
}
if (import.meta.main) embedExactMain();
