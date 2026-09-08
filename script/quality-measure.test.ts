import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureMain } from "./quality-measure";
import { fingerprint, readDocument, recordObject } from "./quality-ci-input";
import { joinBounds } from "./quality-ci-metrics";
import { parseStatic } from "./quality-ci-legs";
import { decodeJson, digest, InventoryError, jsonNumber, jsonObject } from "./quality-inventory";
import { mergeMeasurements, normalizeCensus, normalizeTypes } from "./quality-ci-receipt";
import { parseNativeLcov } from "./quality-native-lcov";

const legs = ["types", "publisher", "export", "store", "metrics"] as const;
const finishFlags = ["legs", "base", "baseline", "plan", "run", "coverage-directory"];

async function childMain(root: string, args: string[]) {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "quality-measure.ts"), ...args], {
		cwd: root, stdout: "pipe", stderr: "pipe", timeout: 30_000,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "quality-measure-"));
	mkdirSync(join(root, "script"));
	writeFileSync(join(root, "script/a.ts"), "export function answer(value: boolean): number {\n  if (value) return 1;\n  return 2;\n}\n");
	writeFileSync(join(root, "script/tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
	writeFileSync(join(root, "contract.json"), JSON.stringify({
		version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false,
	}));
	return realpathSync(root);
}
function finishArgs(root: string) {
	return ["finish", "--root", root, "--contract", "contract.json", ...finishFlags.flatMap((key) => [`--${key}`, key === "legs" ? "legs" : "absent"])];
}
function saveIdentity(root: string, leg: string, identity: { inventoryHash: string; contractHash: string }) {
	writeFileSync(join(root, "legs", `${leg}.identity.json`), JSON.stringify({ version: 1, leg, inventoryHash: identity.inventoryHash, contractHash: identity.contractHash, durationMs: 0 }));
}

test("subcommand admission rejects absent flags in process and at the CLI without output", async () => {
	const root = mkdtempSync(join(tmpdir(), "quality-measure-admission-"));
	try {
		const cases = [[], ["unknown"], ["--output", "quality-results", "collect"], ["collect", "finish"], ["collect"], ["collect", "--leg", "metrics"], ["collect", "--output", "quality-results"], ["collect", "--leg", "invalid", "--output", "quality-results"]];
		for (const omitted of finishFlags) cases.push(["finish", ...finishFlags.filter((key) => key !== omitted).flatMap((key) => [`--${key}`, "absent"])]);
		for (const args of cases) {
			const argv = [...args, "--root", root];
			await expect(measureMain(argv)).rejects.toBeInstanceOf(InventoryError);
			const child = await childMain(root, argv);
			expect(child.exitCode).not.toBe(0);
			expect(child.stdout).toBe("");
			expect(child.stderr.length).toBeGreaterThan(0);
			expect(readdirSync(root)).toEqual([]);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("scoped collect measures selected metrics and types while retaining full resolver identity", async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "script/b.ts"), "export function other(): number { return 2; }\n");
    const plan = { version: 2, class: "desktop", qualityScope: ["script/a.ts"], projects: ["script/tsconfig.json"] };
    writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
    expect(await measureMain(["collect", "--root", root, "--contract", "contract.json", "--leg", "metrics", "--plan", "plan.json", "--output", "scoped"])).toBe(0);
    const document = parseStatic(readDocument(join(root, "scoped/metrics.json")));
    expect(document.measured.map((row) => row.source.path)).toEqual(["script/a.ts"]);
    expect(document.sources.map((row) => row.path)).toEqual(["script/a.ts", "script/b.ts"]);
    const identity = fingerprint(root, "contract.json");
    expect(document.inventoryHash).toBe(identity.inventoryHash);
    writeFileSync(join(root, "inventory.json"), JSON.stringify(identity.inventory));
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "check-types-census.ts"), "--root", root, "--contract", "contract.json", "--inventory", "inventory.json", "--plan", "plan.json"], { timeout: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(decodeJson(child.stdout.toString())).toMatchObject({ measured: ["script/a.ts"], semanticMeasured: ["script/a.ts"], projects: plan.projects });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("metrics collect writes transferable static evidence without coverage and reports its phase", async () => {
	const root = fixture();
	try {
		const child = await childMain(root, ["collect", "--root", root, "--contract", "contract.json", "--leg", "metrics", "--output", "legs"]);
		expect(child.exitCode).toBe(0);
		expect(child.stdout).toBe("");
		expect(child.stderr).toMatch(/^\[quality-phase\] name=metrics ms=\d+\n$/);
		expect(readdirSync(join(root, "legs")).sort()).toEqual(["metrics.identity.json", "metrics.json"]);
		const identity = fingerprint(root, "contract.json");
		const receipt = recordObject(join(root, "legs/metrics.identity.json"));
		const durationMs = jsonNumber(receipt.durationMs);
		expect(receipt).toEqual({ version: 1, leg: "metrics", inventoryHash: identity.inventoryHash, contractHash: identity.contractHash, durationMs });
		expect(Number.isSafeInteger(durationMs)).toBe(true);
		expect(durationMs).toBeGreaterThanOrEqual(0);
		const document = parseStatic(readDocument(join(root, "legs/metrics.json")));
		const result = joinBounds(document, { identity, lines: new Map(), selectedLanes: ["script"] });
		expect(result.records.find((row) => row.name === "answer")).toMatchObject({ cyclomatic: 2, crap: 6 });
		expect(result.measurement.findings.some((row) => row.gate === "coverage")).toBe(true);
		expect(joinBounds(document, { identity, lines: new Map(), selectedLanes: [] }).measurement.findings.some((row) => row.gate === "coverage")).toBe(false);
		await expect(measureMain(["collect", "--root", root, "--contract", "contract.json", "--leg", "metrics", "--output", "legs"])).rejects.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

function nativeFixture(root: string) {
	// Real subprocesses validate the wire contract, while analyzer-specific
	// behavior remains covered by the census suites. Metrics and schemas stay real.
	for (const script of ["check-types-census.ts", "check-census.ts"]) writeFileSync(join(root, "script", script), 'await import("../adapter.mjs");\n');
	writeFileSync(join(root, "adapter-options.json"), JSON.stringify({ python: "python3", exitCode: 1 }));
	writeFileSync(join(root, "adapter.mjs"), `
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const args = new Map();
for (let i = 2; i < Bun.argv.length; i++) {
  const key = Bun.argv[i];
  args.set(key, key === "--json" ? true : Bun.argv[++i]);
}
const root = args.get("--root");
assert.equal(root, process.cwd());
const options = JSON.parse(readFileSync(resolve(root, "adapter-options.json")));
const bytes = readFileSync(resolve(root, args.get("--inventory")));
const inventory = JSON.parse(bytes);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const leg = args.get("--class") ?? "types";
assert(Bun.argv[1].endsWith(leg === "types" ? "/check-types-census.ts" : "/check-census.ts"));
assert.equal(hash(JSON.stringify(JSON.parse(readFileSync(resolve(root, args.get("--contract")))))), inventory.contractHash);
if (leg !== "types") {
  assert.equal(args.get("--json"), true);
  assert.equal(args.get("--inventory-sha256"), hash(bytes));
}
for (const key of leg === "export" ? ["knip"] : leg === "store" ? ["schema", "upgraded-schema"] : []) {
  assert.equal(hash(readFileSync(resolve(root, args.get("--" + key)))), args.get("--" + key + "-sha256"));
}
if (leg === "store") assert.equal(args.get("--python"), options.python);
const scope = args.has("--plan") ? JSON.parse(readFileSync(resolve(root, args.get("--plan")))).qualityScope : inventory.files.map((row) => row.path);
const measured = inventory.files.filter((row) => row.language === "typescript" && scope.includes(row.path)).map((row) => row.path);
const common = { version: 1, complete: true, inventoryHash: hash(bytes), errors: [] };
console.log(JSON.stringify(leg === "types"
  ? { ...common, tool: "typescript@5.9.2", measured, semanticMeasured: measured, violations: [] }
  : { ...common, contractHash: inventory.contractHash, class: leg, analyzedClasses: [leg], counts: { [leg]: 0 }, findings: [] }));
process.exit(options.exitCode);
`);
	symlinkSync(join(import.meta.dir, "../node_modules"), join(root, "node_modules"));
	mkdirSync(join(root, "packages"));
	symlinkSync(join(import.meta.dir, "../packages/ledger"), join(root, "packages/ledger"));
	mkdirSync(join(root, "script/conformance"));
	writeFileSync(join(root, "script/conformance/quality-contract.json"), JSON.stringify(readDocument(join(root, "contract.json"))));
}
function git(root: string, args: string[]) {
	const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
	expect(result.exitCode).toBe(0);
	return result.stdout.toString();
}

test("native collectors transfer receipts and finish joins fresh coverage through the real ratchet", async () => {
	const root = fixture();
	const previousPython = process.env.D945_PYTHON;
	try {
		nativeFixture(root);
		delete process.env.D945_PYTHON;
		git(root, ["init", "-q"]);
		git(root, ["fetch", "-q", "--depth=1", "--no-tags", join(import.meta.dir, ".."), "HEAD"]);
		for (const leg of legs) {
			expect(await measureMain(["collect", "--root", root, "--leg", leg, "--output", "legs"])).toBe(0);
			if (leg === "metrics") continue;
			const processReceipt = recordObject(join(root, "legs", `${leg}.process.json`));
			expect(processReceipt.exitCode).toBe(1);
			expect(processReceipt.runtime).toBe(Bun.version);
			expect(jsonObject(recordObject(join(root, "legs", `${leg}.json`)).document).complete).toBe(true);
		}
		expect(readdirSync(root).some((path) => path.startsWith(".quality-"))).toBe(false);
		process.env.D945_PYTHON = "explicit-python";
		writeFileSync(join(root, "adapter-options.json"), JSON.stringify({ python: "explicit-python", exitCode: 1 }));
		expect(await measureMain(["collect", "--root", root, "--leg", "store", "--output", "explicit-python"])).toBe(0);
		writeFileSync(join(root, "adapter-options.json"), JSON.stringify({ python: "explicit-python", exitCode: 2 }));
		await expect(measureMain(["collect", "--root", root, "--leg", "types", "--output", "failed"])).rejects.toBeInstanceOf(InventoryError);
		expect(readdirSync(join(root, "failed"))).toEqual(["types.process.json"]);
		expect(readdirSync(root).some((path) => path.startsWith(".quality-"))).toBe(false);
		const identity = fingerprint(root, "contract.json");
		const staticDocument = parseStatic(readDocument(join(root, "legs/metrics.json")));
		const lcov = "SF:a.ts\nDA:2,1\nDA:3,0\nLF:2\nLH:1\nend_of_record\n";
		const run = "fixture-run", files = parseNativeLcov(lcov, "script");
		const lines = new Map(files.map((file) => [file.path, new Map(file.lines.map((row) => [row.line, row.hits]))]));
		const metrics = joinBounds(staticDocument, { identity, lines, selectedLanes: ["script"] });
		const native = (leg: string) => jsonObject(readDocument(join(root, "legs", `${leg}.json`))).document ?? null;
		const current = mergeMeasurements([...identity.paths, ...identity.schemaPaths], [
			normalizeTypes(native("types"), identity),
			...(["publisher", "export", "store"] as const).map((leg) => normalizeCensus(native(leg), identity, leg)), metrics.measurement,
		]);
		writeFileSync(join(root, "baseline.json"), JSON.stringify(current));
		writeFileSync(join(root, "plan.json"), JSON.stringify({ version: 2, class: "global", qualityScope: identity.inventory.files.map((row) => row.path), projects: ["script/tsconfig.json"], matrix: { include: [{ dir: "script", coverage: true }] } }));
		mkdirSync(join(root, "coverage"));
		writeFileSync(join(root, "coverage/script.json"), JSON.stringify({ version: 1, complete: true, lane: "script", run, runtime: Bun.version, inventoryHash: identity.inventoryHash, lcovHash: digest(lcov), lcov, files }));
		const args = ["finish", "--legs", "legs", "--base", "FETCH_HEAD", "--baseline", "baseline.json", "--plan", "plan.json", "--run", run, "--coverage-directory", "coverage"];
		const child = await childMain(root, args);
		expect(child.exitCode).toBe(0);
		expect(decodeJson(child.stdout)).toMatchObject({ complete: true, violations: 0 });
		expect(child.stderr.trim().split("\n").map((line) => /^\[quality-phase\] name=(\w+) ms=\d+$/.exec(line)?.[1])).toEqual(["fingerprint", "coverage", "join", "ratchet"]);
		expect(readdirSync(join(root, "quality-results")).sort()).toEqual(["coverage.json", "current.json", "inventory.json", "metrics.json"]);
		expect(readDocument(join(root, "quality-results/current.json"))).toEqual(decodeJson(JSON.stringify(current)));
		expect(readDocument(join(root, "quality-results/metrics.json"))).toEqual(decodeJson(JSON.stringify(metrics)));
		await expect(measureMain([...args, "--root", root])).rejects.toThrow();
		const inProcess = [...args, "--root", root, "--output", "second-results"];
		mkdirSync(join(root, "packages/protocol/src"), { recursive: true });
		writeFileSync(join(root, "packages/protocol/src/unselected.ts"), "export const unselected = 1;\n");
		await expect(measureMain(inProcess)).rejects.toMatchObject({ name: "InventoryError", code: "measurement" });
		expect(existsSync(join(root, "second-results"))).toBe(false);
		rmSync(join(root, "packages/protocol"), { recursive: true });
		expect(await measureMain(inProcess)).toBe(0);
		const error = console.error;
		try {
			console.error = (line: string) => {
				if (line.startsWith("[quality-phase] name=coverage ")) writeFileSync(join(root, "script/a.ts"), "export const changed = 1;\n");
			};
			await expect(measureMain([...args, "--root", root, "--output", "drift-results"])).rejects.toMatchObject({ name: "InventoryError", code: "measurement" });
		} finally {
			console.error = error;
		}
	} finally {
		if (previousPython === undefined) delete process.env.D945_PYTHON;
		else process.env.D945_PYTHON = previousPython;
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

test("finish preserves full-tier bytes and carries only hash-proven scoped debt", async () => {
  const root = fixture();
  try {
    nativeFixture(root);
    writeFileSync(join(root, "adapter-options.json"), JSON.stringify({ python: process.env.D945_PYTHON ?? "python3", exitCode: 1 }));
    git(root, ["init", "-q"]);
    git(root, ["add", "script", "contract.json", "adapter.mjs", "adapter-options.json"]);
    git(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    const identity = fingerprint(root, "contract.json");
    const matrix = { include: [{ dir: "script", coverage: true }] };
    const plan = { version: 2, class: "global", qualityScope: identity.inventory.files.map((row) => row.path), projects: ["script/tsconfig.json"], matrix };
    writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
    const lcov = "SF:a.ts\nDA:2,1\nDA:3,0\nLF:2\nLH:1\nend_of_record\n";
    const files = parseNativeLcov(lcov, "script");
    const lines = new Map(files.map((file) => [file.path, new Map(file.lines.map((row) => [row.line, row.hits]))]));
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage/script.json"), JSON.stringify({ version: 1, complete: true, lane: "script", run: "equivalent", runtime: Bun.version, inventoryHash: identity.inventoryHash, lcovHash: digest(lcov), lcov, files }));
    for (const leg of legs) expect(await measureMain(["collect", "--root", root, "--leg", leg, "--output", "legacy"])).toBe(0);
    const native = (leg: string) => jsonObject(readDocument(join(root, "legacy", `${leg}.json`))).document ?? null;
    const metrics = joinBounds(parseStatic(readDocument(join(root, "legacy/metrics.json"))), { identity, lines, selectedLanes: ["script"] });
    const before = mergeMeasurements([...identity.paths, ...identity.schemaPaths], [normalizeTypes(native("types"), identity), ...(["publisher", "export", "store"] as const).map((leg) => normalizeCensus(native(leg), identity, leg)), metrics.measurement]);
    const baseline = { ...before, sha256: Object.fromEntries(identity.inventory.files.map((row) => [row.path, row.sha256])) };
    writeFileSync(join(root, "baseline.json"), JSON.stringify(baseline));
    const finish = (directory: string, output: string) => ["finish", "--root", root, "--legs", directory, "--base", "HEAD", "--baseline", "baseline.json", "--plan", "plan.json", "--run", "equivalent", "--coverage-directory", "coverage", "--output", output];
    expect(await measureMain(finish("legacy", "before"))).toBe(0);
    for (const leg of legs) expect(await measureMain(["collect", "--root", root, "--leg", leg, "--plan", "plan.json", "--output", "global"])).toBe(0);
    expect(await measureMain(finish("global", "after"))).toBe(0);
    expect(await Bun.file(join(root, "before/current.json")).text()).toBe(await Bun.file(join(root, "after/current.json")).text());
    const beforeSha256 = digest(JSON.stringify(before));
    const afterSha256 = digest(await Bun.file(join(root, "after/current.json")).text());
    expect(afterSha256).toBe(beforeSha256);
    console.info(JSON.stringify({ equivalence: "full-tier", beforeSha256, afterSha256 }));
    const completeMetrics = jsonObject(readDocument(join(root, "global/metrics.json")));
    writeFileSync(join(root, "global/metrics.json"), JSON.stringify({ ...completeMetrics, measured: [] }));
    await expect(measureMain(finish("global", "missing-metrics"))).rejects.toMatchObject({ code: "measurement" });
    writeFileSync(join(root, "global/metrics.json"), JSON.stringify(completeMetrics));
    writeFileSync(join(root, "plan.json"), JSON.stringify({ ...plan, class: "desktop", qualityScope: ["script/a.ts"] }));
    for (const leg of legs) expect(await measureMain(["collect", "--root", root, "--leg", leg, "--plan", "plan.json", "--output", "scoped"])).toBe(0);
    expect(await measureMain(finish("scoped", "carried"))).toBe(0);
    writeFileSync(join(root, "baseline.json"), JSON.stringify({ ...baseline, sha256: { ...baseline.sha256, "script/check-census.ts": "0".repeat(64) } }));
    await expect(measureMain(finish("scoped", "tampered"))).rejects.toMatchObject({ message: "unchanged proof mismatch: script/check-census.ts" });
    const child = await childMain(root, finish("scoped", "cli-tampered"));
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain("script/check-census.ts");
    console.info(JSON.stringify({ scopedFinish: 0, tamperedFinish: child.exitCode, rejectedPath: "script/check-census.ts" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("finish admits every leg identity before coverage and fails closed on missing or stale evidence", async () => {
	const root = fixture();
	try {
		mkdirSync(join(root, "legs"));
		const args = finishArgs(root);
		const identity = fingerprint(root, "contract.json");
		for (const leg of legs) {
			await expect(measureMain(args)).rejects.toMatchObject({ name: "InventoryError", code: "measurement", message: `missing quality leg: ${leg}` });
			saveIdentity(root, leg, identity);
		}
		const receipt = join(root, "legs/metrics.identity.json");
		for (const patch of [{ inventoryHash: "stale" }, { contractHash: "stale" }, { version: 2 }, { leg: "types" }, { durationMs: -1 }]) {
			writeFileSync(receipt, JSON.stringify({ version: 1, leg: "metrics", inventoryHash: identity.inventoryHash, contractHash: identity.contractHash, durationMs: 0, ...patch }));
			await expect(measureMain(args)).rejects.toBeInstanceOf(InventoryError);
		}
		rmSync(receipt);
		expect(await measureMain(["collect", "--root", root, "--contract", "contract.json", "--leg", "metrics", "--output", "legs"])).toBe(0);
		writeFileSync(join(root, "script/a.ts"), "export const changed = 1;\n");
		const changed = fingerprint(root, "contract.json");
		for (const leg of legs.filter((leg) => leg !== "metrics")) saveIdentity(root, leg, changed);
		await expect(measureMain(args)).rejects.toMatchObject({ name: "InventoryError", code: "measurement", message: "stale quality leg: metrics" });
		expect(existsSync(join(root, "quality-results"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
