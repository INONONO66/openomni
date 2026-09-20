import { expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJson, jsonNumber, jsonObject } from "./quality-inventory";
import { joinMain, joinShardDocuments } from "./quality-mutation-join";
import { mutationFixture, record } from "./quality-mutation-fixture";
import { mutationMain } from "./quality-native-mutation";
import { fingerprint } from "./quality-ci-input";
import { decode, execute, sha256 } from "./run-quality-mutations";

const { fixture, tool, decision, dependencies, runner } = mutationFixture("shard");

type Fixture = { root: string; inventory: string };
/** The wrapper hashes JSON.stringify(inventory) without the CLI's trailing
 * newline; align the fixture file so raw-runner and wrapper runs share one
 * inventory hash and therefore one progress stream. */
function canonicalizeInventory(input: Fixture): void {
  writeFileSync(input.inventory, JSON.stringify(decodeJson(readFileSync(input.inventory, "utf8"))));
}
function runnerArgs(input: Fixture): string[] {
  const paths = { contract: join(input.root, "contract.json"), inventory: input.inventory, decision, "inventory-tool": tool };
  const base = [process.execPath, runner, "--root", input.root, "--dependencies", dependencies];
  for (const [key, path] of Object.entries(paths)) base.push(`--${key}`, path, `--${key}-sha256`, sha256(readFileSync(path)));
  base.push("--python", process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3");
  return base;
}
function shardDocument(root: string, output: string) {
  const native = jsonObject(decodeJson(readFileSync(join(root, output, "native.json"), "utf8")));
  const document = jsonObject(native.document);
  return { document, shard: jsonObject(document.shard) };
}

test("shard slices resume append-only progress and join into the single full receipt", async () => {
  // Mutants live only under packages/ (expression body, no statement sites in
  // test files), so every outcome is behavioral: killed/survived/invalid.
  const input = await fixture("", "", {
    "src/a.test.ts": 'import "../support/assertion";',
    "packages/demo/src/main.ts": "export const run = (value: number) => value > 1;",
    "support/assertion.ts":
      'import {test,expect} from "bun:test";import {run} from "../packages/demo/src/main";test("behavior",()=>{expect(run(2)).toBe(true);expect(run(0)).toBe(false);});',
  });
  const contractPath = join(input.root, "contract.json");
  const contract = jsonObject(decodeJson(readFileSync(contractPath, "utf8")));
  writeFileSync(contractPath, JSON.stringify({ ...contract, roots: ["src", "packages"] }));
  const regenerated = await execute([process.execPath, tool, "--root", input.root, "--contract", contractPath], input.root, 15000);
  expect(regenerated.exitCode).toBe(0);
  writeFileSync(input.inventory, JSON.stringify(decodeJson(regenerated.stdout)));
  cpSync(import.meta.dir, join(input.root, "script"), { recursive: true });
  cpSync(dependencies, join(input.root, "node_modules"), { recursive: true, dereference: true });
  const progress0 = join(input.root, "progress", "shard-0.jsonl");
  // Budget-exhausted first run: clean partial stop, exit 0, nothing executed.
  const partial = await execute([...runnerArgs(input), "--shard", "0", "--shard-count", "2", "--progress", progress0, "--budget", "1"], input.root, 120000);
  expect(partial.exitCode).toBe(0);
  const partialDocument = record(decode(partial.stdout));
  const partialShard = record(partialDocument.shard);
  expect(partialDocument.full).toBe(false);
  expect(partialDocument.complete).toBe(false);
  expect(partialShard.budgetExhausted).toBe(true);
  expect(partialShard.executed).toBe(0);
  expect(partialShard.sliceComplete).toBe(false);
  const headerOf = (path: string) => record(decode(readFileSync(path, "utf8").split("\n")[0] ?? "null"));
  // Same inventory, another slice's artifact: mixing must fail closed.
  const misSharded = await execute([...runnerArgs(input), "--shard", "1", "--shard-count", "2", "--progress", progress0, "--budget", "1"], input.root, 120000);
  expect(misSharded.exitCode).toBe(2);
  const misShardedError = record(record(decode(misSharded.stdout)).error);
  expect(misShardedError.code).toBe("progress");
  expect(misShardedError.message).toContain("shardIndex");
  // A different inventory's artifact is discarded (logged) and overwritten:
  // the campaign self-heals across commits instead of wedging red.
  const foreign = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
  canonicalizeInventory(foreign);
  const foreignProgress = join(foreign.root, "foreign-progress.jsonl");
  cpSync(progress0, foreignProgress);
  const discarded = await execute([...runnerArgs(foreign), "--shard", "0", "--shard-count", "2", "--progress", foreignProgress, "--budget", "1"], foreign.root, 120000);
  expect(discarded.exitCode).toBe(0);
  expect(discarded.stderr).toContain("progress artifact for inventory");
  expect(discarded.stderr).toContain("discarded (current ");
  const staleHash = headerOf(progress0).inventorySha256;
  const rewritten = readFileSync(foreignProgress, "utf8").split("\n").filter((line) => line.length).map((line) => record(decode(line)));
  expect(rewritten.length).toBeGreaterThan(0);
  for (const row of rewritten) expect(row.inventorySha256).not.toBe(staleHash);
  // An existing but unparseable header stays a hard refusal.
  const malformed = join(foreign.root, "malformed-progress.jsonl");
  writeFileSync(malformed, "not json\n");
  const refused = await execute([...runnerArgs(foreign), "--shard", "0", "--shard-count", "2", "--progress", malformed, "--budget", "1"], foreign.root, 120000);
  expect(refused.exitCode).toBe(2);
  expect(record(record(decode(refused.stdout)).error).code).toBe("progress");
  // An unparseable line that is not final also stays a hard refusal.
  const tornMiddle = join(foreign.root, "torn-middle-progress.jsonl");
  const [progressHead, ...progressTail] = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length);
  expect(progressTail.length).toBeGreaterThan(0);
  writeFileSync(tornMiddle, [progressHead, '{"type":"result","run":"torn', ...progressTail].map((line) => `${line}\n`).join(""));
  const tornRefused = await execute([...runnerArgs(input), "--shard", "0", "--shard-count", "2", "--progress", tornMiddle, "--budget", "1"], input.root, 120000);
  expect(tornRefused.exitCode).toBe(2);
  expect(record(record(decode(tornRefused.stdout)).error).code).toBe("progress");
  // Resumed wrapper run completes shard 0 within its budget.
  const base = ["--root", input.root, "--contract", "contract.json", "--decision", decision, "--baseline", "missing-baseline.json"];
  const shardBase = [...base, "--shard", "0", "--shard-count", "2", "--progress", progress0];
  expect(await mutationMain([...shardBase, "--output", "shard-0-a", "--budget-minutes", "30"])).toBe(0);
  const first = shardDocument(input.root, "shard-0-a");
  expect(first.document.full).toBe(false);
  expect(first.document.complete).toBe(true);
  expect(first.shard.sliceComplete).toBe(true);
  const sliceSize = jsonNumber(first.shard.sliceSize);
  expect(sliceSize).toBeGreaterThan(0);
  expect(jsonNumber(first.shard.recorded)).toBe(sliceSize);
  expect(jsonNumber(first.shard.executed)).toBe(sliceSize);
  // Rows from a run that never appended its restoration proof are never
  // carried: append a tampered duplicate under an unproven run id and confirm
  // the resumed run keeps the proven outcomes.
  const progressRows = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length).map((line) => record(decode(line)));
  const sample = progressRows.find((row) => row.type === "result") ?? {};
  const tamperedResult = { ...record(sample.result) };
  tamperedResult.outcome = tamperedResult.outcome === "killed" ? "survived" : "killed";
  appendFileSync(progress0, `${JSON.stringify({ ...sample, run: "unproven-run", result: tamperedResult })}\n`);
  // A job killed mid-append leaves a torn trailing line; the next run drops
  // exactly that line with a warning and repairs the artifact.
  appendFileSync(progress0, '{"type":"result","run":"torn');
  // Re-running the complete shard carries every result and executes none.
  expect(await mutationMain([...shardBase, "--output", "shard-0-b"])).toBe(0);
  const carried = shardDocument(input.root, "shard-0-b");
  expect(carried.document.complete).toBe(true);
  expect(jsonNumber(carried.shard.executed)).toBe(0);
  expect(jsonNumber(carried.shard.recorded)).toBe(sliceSize);
  expect(record(carried.document.counts)).toEqual(record(first.document.counts));
  const repaired = readFileSync(progress0, "utf8");
  expect(repaired).not.toContain('"run":"torn');
  for (const line of repaired.split("\n").filter((piece) => piece.length)) decode(line);
  const lines = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length).map((line) => record(decode(line)));
  expect(lines[0]?.type).toBe("shard-progress");
  // sliceSize proven rows plus the tampered unproven duplicate (kept in the
  // artifact, ignored by the loader because its run id has no proof row).
  expect(lines.filter((line) => line.type === "result")).toHaveLength(sliceSize + 1);
  expect(lines.filter((line) => line.type === "proof").length).toBeGreaterThanOrEqual(2);
  // Second shard completes its disjoint slice.
  expect(await mutationMain([...base, "--shard", "1", "--shard-count", "2", "--progress", join(input.root, "progress", "shard-1.jsonl"), "--output", "shard-1"])).toBe(0);
  const second = shardDocument(input.root, "shard-1");
  expect(second.document.complete).toBe(true);
  // Join: all shards complete -> the existing full receipt shape plus ratchet.
  const joinDir = join(input.root, "join-shards");
  for (const [index, output] of [["0", "shard-0-b"], ["1", "shard-1"]] as const) {
    mkdirSync(join(joinDir, `quality-mutation-shard-${index}`), { recursive: true });
    cpSync(join(input.root, output, "native.json"), join(joinDir, `quality-mutation-shard-${index}`, "native.json"));
  }
  expect(joinMain(["--root", input.root, "--contract", "contract.json", "--baseline", "missing-baseline.json", "--shards", joinDir, "--output", "joined"])).toBe(2);
  const joined = jsonObject(jsonObject(decodeJson(readFileSync(join(input.root, "joined", "native.json"), "utf8"))).document);
  expect(joined.full).toBe(true);
  expect(joined.complete).toBe(true);
  const results = joined.results;
  expect(Array.isArray(results) && results.length).toBe(sliceSize + jsonNumber(second.shard.sliceSize));
  const merged = jsonObject(decodeJson(readFileSync(join(input.root, "joined", "current.json"), "utf8")));
  expect(merged.analyzed).toEqual(["mutation"]);
  // Join with a partial shard document: incomplete summary, exit 0, no receipt.
  const partialDir = join(input.root, "join-partial");
  mkdirSync(join(partialDir, "quality-mutation-shard-1"), { recursive: true });
  cpSync(join(joinDir, "quality-mutation-shard-1", "native.json"), join(partialDir, "quality-mutation-shard-1", "native.json"));
  mkdirSync(join(partialDir, "quality-mutation-shard-0"), { recursive: true });
  writeFileSync(join(partialDir, "quality-mutation-shard-0", "native.json"), JSON.stringify({ command: ["runner"], exitCode: partial.exitCode, document: partialDocument }));
  expect(joinMain(["--root", input.root, "--contract", "contract.json", "--baseline", "missing-baseline.json", "--shards", partialDir, "--output", "joined-partial"])).toBe(0);
  expect(existsSync(join(input.root, "joined-partial"))).toBe(false);
  // Stale identity fails closed inside the real join function.
  expect(() =>
    joinShardDocuments([first.document], { inventoryHash: "0".repeat(64), contractHash: "0".repeat(64), paths: [], typescript: [] }),
  ).toThrow("stale shard inventory");
  // Spawned exit codes for the join entry point.
  const script = join(import.meta.dir, "quality-mutation-join.ts");
  const incomplete = Bun.spawnSync([process.execPath, script, "--root", input.root, "--contract", "contract.json", "--baseline", "missing-baseline.json", "--shards", partialDir, "--output", "joined-spawn"], { timeout: 120000 });
  expect(incomplete.exitCode).toBe(0);
  expect(incomplete.stderr.toString()).toContain("campaign incomplete: shards 1/2 complete");
  const missingBaseline = Bun.spawnSync([process.execPath, script], { timeout: 120000 });
  expect(missingBaseline.exitCode).toBe(1);
}, 600000);

test("shard arguments are validated before any campaign work starts", async () => {
  await expect(mutationMain(["--baseline", "b.json", "--shard", "0"])).rejects.toThrow("sharded execution requires");
  await expect(
    mutationMain(["--baseline", "b.json", "--pilot", "--shard", "0", "--shard-count", "2", "--progress", "p.jsonl"]),
  ).rejects.toThrow("--shard is incompatible with --pilot");
  await expect(
    mutationMain(["--baseline", "b.json", "--shard", "0", "--shard-count", "2", "--progress", "p.jsonl", "--budget-minutes", "0"]),
  ).rejects.toThrow("invalid --budget-minutes");
  expect(() => joinMain([])).toThrow("measured mutation baseline required");
  expect(() => joinMain(["--baseline", "b.json"])).toThrow("shard documents directory required");
});

test("an all-invalid slice completes per shard while the join enforces campaign validity", async () => {
  const input = await fixture("", "", {
    "src/a.test.ts": 'import "../support/assertion";',
    "packages/demo/src/main.ts": "export const value: true = true;",
    "support/assertion.ts":
      'import {test,expect} from "bun:test";import {value} from "../packages/demo/src/main";test("behavior",()=>{expect(value).toBe(true);});',
  });
  const contractPath = join(input.root, "contract.json");
  const contract = jsonObject(decodeJson(readFileSync(contractPath, "utf8")));
  writeFileSync(contractPath, JSON.stringify({ ...contract, roots: ["src", "packages"] }));
  cpSync(import.meta.dir, join(input.root, "script"), { recursive: true });
  cpSync(dependencies, join(input.root, "node_modules"), { recursive: true, dereference: true });
  const progress = join(input.root, "progress", "shard-0.jsonl");
  expect(
    await mutationMain(["--root", input.root, "--contract", "contract.json", "--decision", decision, "--baseline", "missing-baseline.json", "--shard", "0", "--shard-count", "1", "--progress", progress, "--output", "shard-only"]),
  ).toBe(0);
  const only = shardDocument(input.root, "shard-only");
  const counts = jsonObject(only.document.counts);
  expect(jsonNumber(counts.invalid)).toBeGreaterThan(0);
  expect(jsonNumber(counts.killed) + jsonNumber(counts.survived) + jsonNumber(counts.noCoverage)).toBe(0);
  expect(only.document.complete).toBe(true);
  expect(only.shard.sliceComplete).toBe(true);
  // The valid-outcome sanity floor moved to the campaign level: the join
  // refuses to mint a receipt from a campaign with zero valid outcomes.
  const identity = fingerprint(input.root, "contract.json");
  expect(() => joinShardDocuments([only.document], identity)).toThrow("no valid outcomes across shards");
}, 300000);
