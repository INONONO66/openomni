import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJson, jsonNumber, jsonObject } from "./quality-inventory";
import { joinMain, joinShardDocuments } from "./quality-mutation-join";
import { mutationFixture, record } from "./quality-mutation-fixture";
import { mutationMain } from "./quality-native-mutation";
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
  // A different inventory refuses the progress artifact instead of mixing.
  const foreign = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
  canonicalizeInventory(foreign);
  const refused = await execute([...runnerArgs(foreign), "--shard", "0", "--shard-count", "2", "--progress", progress0, "--budget", "1"], foreign.root, 120000);
  expect(refused.exitCode).toBe(2);
  expect(record(record(decode(refused.stdout)).error).code).toBe("progress");
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
  // Re-running the complete shard carries every result and executes none.
  expect(await mutationMain([...shardBase, "--output", "shard-0-b"])).toBe(0);
  const carried = shardDocument(input.root, "shard-0-b");
  expect(carried.document.complete).toBe(true);
  expect(jsonNumber(carried.shard.executed)).toBe(0);
  expect(jsonNumber(carried.shard.recorded)).toBe(sliceSize);
  const lines = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length).map((line) => record(decode(line)));
  expect(lines[0]?.type).toBe("shard-progress");
  expect(lines.filter((line) => line.type === "result")).toHaveLength(sliceSize);
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
