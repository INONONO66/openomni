import { appendFileSync } from "node:fs";
import { z } from "zod";
import { decodeJson, type Json } from "./quality-json";
import { EXPECTED_BENCHMARK_NAMES } from "./summarize-benchmark-runs";

const Metric = z.object({ name: z.string(), unit: z.literal("ns/op"), value: z.number().nonnegative() });
const Statistics = z.array(Metric.extend({ p50: z.number().nonnegative(), runs: z.number().int().positive() }));
const History = z.object({ entries: z.object({ "OpenOmni Benchmarks": z.array(z.object({
  commit: z.object({ id: z.string().min(1) }),
  tool: z.literal("customSmallerIsBetter"),
  benches: z.array(Metric),
})).nonempty() }) });

export function regressionThreshold(input = "20"): number {
  return z.coerce.number().positive().parse(input);
}

/** data.js is JSON with a fixed assignment wrapper, never executable input. */
export function readBenchmarkHistory(source: string): Json {
  return decodeJson(source.replace(/^\s*window\.BENCHMARK_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export function compareBenchmarks(statistics: Json, history: Json, threshold = 20) {
  const percent = regressionThreshold(String(threshold));
  const current = Statistics.parse(statistics);
  const accepted = History.parse(history).entries["OpenOmni Benchmarks"].slice(-20);
  const latest = accepted[accepted.length - 1];
  if (!latest) throw new Error("Missing accepted main benchmark reference");
  const names = [...EXPECTED_BENCHMARK_NAMES].sort();
  if (current.map((metric) => metric.name).sort().join("\n") !== names.join("\n")) {
    throw new Error("Current benchmark metric set is incomplete or duplicated");
  }
  const comparisons = current.map((metric) => {
    const references = latest.benches.filter((entry) => entry.name === metric.name);
    const reference = references[0];
    if (references.length !== 1 || !reference) throw new Error(`Missing or duplicate reference: ${metric.name}`);
    const values = accepted.flatMap((entry) => entry.benches.filter((bench) => bench.name === metric.name).map((bench) => bench.value));
    const noiseBand = 2 * standardDeviation(values);
    const delta = metric.p50 - reference.value;
    return {
      name: metric.name, median: metric.p50, reference: reference.value, noiseBand,
      limit: Math.max(reference.value * (1 + percent / 100), reference.value + noiseBand),
      regressed: delta > reference.value * percent / 100 && delta > noiseBand,
    };
  });
  return { referenceCommit: latest.commit.id, threshold: percent, comparisons, failed: comparisons.some((metric) => metric.regressed) };
}

export async function main(args = Bun.argv.slice(2)): Promise<number> {
  const threshold = regressionThreshold(process.env.BENCHMARK_REGRESSION_PERCENT);
  if (args[0] === "--validate-input") return 0;
  const statistics = decodeJson(await Bun.file(args[0] ?? "bench-results/statistics.json").text());
  const history = readBenchmarkHistory(await Bun.file(args[1] ?? "bench-results/reference.js").text());
  const result = compareBenchmarks(statistics, history, threshold);
  const summary = [
    "## Benchmark regression gate", "",
    `Accepted main reference: ${result.referenceCommit}. Fail above both ${threshold}% and two sample standard deviations of the latest 20 accepted medians (zero band with fewer than two samples).`, "",
    "| Benchmark | PR p50 ns/op | Reference ns/op | Limit ns/op | Result |",
    "| --- | ---: | ---: | ---: | --- |",
    ...result.comparisons.map((metric) => `| ${metric.name} | ${metric.median} | ${metric.reference} | ${metric.limit} | ${metric.regressed ? "FAIL" : "PASS"} |`), "",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  await Bun.write("bench-results/regression.json", `${JSON.stringify(result, null, 2)}\n`);
  return result.failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
