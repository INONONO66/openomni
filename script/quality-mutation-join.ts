import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  decodeJson,
  digest,
  jsonArray,
  jsonChoice,
  jsonNumber,
  jsonObject,
  jsonString,
  type Json,
} from "./quality-inventory";
import { fingerprint } from "./quality-ci-input";
import { mergeMeasurements, requireMeasurement, type Identity } from "./quality-ci-receipt";
import { normalizeMutation } from "./quality-native-mutation";
import { ratchetMain } from "./quality-ratchet";

const outcomes = ["killed", "survived", "noCoverage", "invalid", "infrastructure", "uncompleted"] as const;
export type JoinOutcome =
  | { complete: false; summary: string }
  | { complete: true; summary: string; document: Json };

function shardDocuments(directory: string): Json[] {
  const files = [...new Bun.Glob("**/native.json").scanSync({ cwd: directory })].sort();
  return files.map((file) => jsonObject(decodeJson(readFileSync(resolve(directory, file), "utf8"))).document ?? null);
}

/** Merge complete shard documents into the single full-campaign receipt shape.
 * Every shard must carry the same inventory hash and census, disjoint result
 * slices, and its own restoration/cleanup proof; those proofs are per-process,
 * so the joined receipt is only as verified as the weakest shard. */
export function joinShardDocuments(documents: Json[], identity: Identity): JoinOutcome {
  requireMeasurement(documents.length > 0, "no shard documents to join");
  const shards = documents.map((document) => {
    const row = jsonObject(document);
    requireMeasurement(row.version === 1 && row.full === false, "join requires shard campaign documents");
    requireMeasurement(row.inventorySha256 === identity.inventoryHash, "stale shard inventory");
    return { row, shard: jsonObject(row.shard) };
  });
  const count = jsonNumber(shards[0]?.shard.count);
  requireMeasurement(Number.isSafeInteger(count) && count >= 1, "invalid shard count");
  const byIndex = new Map<number, (typeof shards)[number]>();
  for (const entry of shards) {
    requireMeasurement(jsonNumber(entry.shard.count) === count, "shard count mismatch");
    const index = jsonNumber(entry.shard.index);
    requireMeasurement(index >= 0 && index < count && !byIndex.has(index), "duplicate or out-of-range shard index");
    byIndex.set(index, entry);
  }
  const complete = [...byIndex.values()].filter(
    (entry) => entry.row.complete === true && entry.shard.sliceComplete === true,
  );
  if (complete.length < count)
    return { complete: false, summary: `campaign incomplete: shards ${complete.length}/${count} complete` };
  const ordered = complete.sort((a, b) => jsonNumber(a.shard.index) - jsonNumber(b.shard.index));
  const censusSha256 = digest(JSON.stringify(ordered[0]?.row.census ?? null));
  const counts = { killed: 0, survived: 0, noCoverage: 0, invalid: 0, infrastructure: 0, uncompleted: 0 };
  const results: Json[] = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    requireMeasurement(digest(JSON.stringify(entry.row.census)) === censusSha256, "shard census mismatch");
    requireMeasurement(
      entry.row.originalHashesVerified === true && entry.row.cleanupVerified === true,
      "unverified shard restoration",
    );
    requireMeasurement(jsonArray(entry.row.errors, (error) => error).length === 0, "shard campaign errors");
    for (const result of jsonArray(entry.row.results, jsonObject)) {
      const id = jsonString(result.id);
      requireMeasurement(!seen.has(id), "overlapping shard slices");
      seen.add(id);
      counts[jsonChoice(result.outcome, outcomes)] += 1;
      results.push(result);
    }
  }
  const document: Json = {
    version: 1,
    algorithm: "d945-mutation@1",
    joined: true,
    full: true,
    complete: true,
    globalZero: false,
    mutationZero: counts.survived === 0 && counts.noCoverage === 0,
    counts,
    selectedCounts: counts,
    errors: [],
    inventorySha256: identity.inventoryHash,
    censusSha256,
    census: ordered[0]?.row.census ?? null,
    shards: ordered.map((entry) => ({
      shard: entry.shard,
      executionTreeSha256: entry.row.executionTreeSha256 ?? null,
      runnerSha256: entry.row.runnerSha256 ?? null,
    })),
    results,
    originalHashesVerified: true,
    cleanupVerified: true,
  };
  return {
    complete: true,
    summary: `campaign complete: ${count}/${count} shards, ${results.length} results`,
    document,
  };
}

export function joinMain(argv = Bun.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      root: { type: "string", default: process.cwd() },
      contract: { type: "string", default: "script/conformance/quality-contract.json" },
      baseline: { type: "string" },
      base: { type: "string", default: "origin/main" },
      shards: { type: "string" },
      output: { type: "string", default: "quality-mutation-results" },
    },
  });
  requireMeasurement(Boolean(values.baseline), "measured mutation baseline required");
  requireMeasurement(Boolean(values.shards), "shard documents directory required");
  const root = resolve(values.root),
    directory = resolve(root, values.output);
  console.error("[mutation] fingerprinting source inventory for join");
  const identity = fingerprint(root, values.contract);
  const joined = joinShardDocuments(shardDocuments(resolve(values.shards ?? "")), identity);
  console.error(`[mutation] ${joined.summary}`);
  if (!joined.complete) return 0;
  mkdirSync(directory);
  writeFileSync(
    resolve(directory, "native.json"),
    JSON.stringify({ command: ["quality-mutation-join"], exitCode: 0, document: joined.document }),
    { flag: "wx" },
  );
  const measurement = normalizeMutation(joined.document, identity, root);
  requireMeasurement(
    fingerprint(root, values.contract).inventoryHash === identity.inventoryHash,
    "sources changed during mutation join",
  );
  const current = resolve(directory, "current.json");
  writeFileSync(current, JSON.stringify(mergeMeasurements(identity.paths, [measurement])), {
    flag: "wx",
  });
  return ratchetMain([
    "--root",
    root,
    "--contract",
    resolve(root, values.contract),
    "--base",
    values.base,
    "--baseline",
    values.baseline ?? "",
    "--current",
    current,
  ]);
}
if (import.meta.main) process.exitCode = joinMain();
