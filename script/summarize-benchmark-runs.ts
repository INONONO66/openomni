import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type BenchmarkMetric = {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
};

type BenchmarkRun = {
  readonly name: string;
  readonly metrics: readonly BenchmarkMetric[];
};

type BenchmarkStats = BenchmarkMetric & {
  readonly runs: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
};

export const EXPECTED_BENCHMARK_NAMES = [
  "bus-fanout/10-subscribers",
  "bus-fanout/50-subscribers",
  "bus-fanout/100-subscribers",
  "compaction/20-messages",
  "compaction/100-messages",
  "compaction/500-messages",
  "compaction/should-compact",
  "message-serialization/parse-message",
  "message-serialization/stringify-message",
  "session-hydration/get-messages",
  "session-hydration/get-session",
  "storage-session-list/10-sessions",
  "storage-session-list/100-sessions",
  "storage-session-list/500-sessions",
] as const;

const DEFAULT_INPUT_DIR = "bench-results/runs";
const DEFAULT_GATE_OUTPUT = "bench-results/combined.json";
const DEFAULT_STATS_OUTPUT = "bench-results/statistics.json";
const DEFAULT_SUMMARY_OUTPUT = "bench-results/summary.md";

async function main(): Promise<void> {
  const inputDir = Bun.argv[2] ?? DEFAULT_INPUT_DIR;
  const gateOutputPath = Bun.argv[3] ?? DEFAULT_GATE_OUTPUT;
  const statsOutputPath = Bun.argv[4] ?? DEFAULT_STATS_OUTPUT;
  const summaryOutputPath = Bun.argv[5] ?? DEFAULT_SUMMARY_OUTPUT;
  const expectedRuns = Number.parseInt(process.env.BENCHMARK_RUNS ?? "", 10);
  if (!Number.isSafeInteger(expectedRuns) || expectedRuns < 1) {
    throw new Error("BENCHMARK_RUNS must be a positive integer");
  }

  const metrics = validateBenchmarkRuns(await readBenchmarkRuns(inputDir), expectedRuns);
  const stats = summarizeMetrics(metrics);
  writeJson(gateOutputPath, toGateMetrics(stats));
  writeJson(statsOutputPath, stats);
  await Bun.write(summaryOutputPath, renderSummary(stats));
}

async function readBenchmarkRuns(root: string): Promise<BenchmarkRun[]> {
  const entries = readdirSync(root, { withFileTypes: true });
  const runs: BenchmarkRun[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error(`Benchmark run root contains a non-directory entry: ${join(root, entry.name)}`);
    }
    const runRoot = join(root, entry.name);
    const metrics: BenchmarkMetric[] = [];
    for (const path of collectJsonFiles(runRoot)) {
      const parsed: unknown = JSON.parse(await Bun.file(path).text());
      if (!Array.isArray(parsed)) {
        throw new Error(`Benchmark file must contain an array: ${path}`);
      }
      for (const item of parsed) {
        if (!isBenchmarkMetric(item)) {
          throw new Error(`Invalid benchmark metric in ${path}`);
        }
        metrics.push(item);
      }
    }
    runs.push({ name: entry.name, metrics });
  }

  return runs.sort((left, right) => left.name.localeCompare(right.name));
}

export function validateBenchmarkRuns(
  runs: readonly BenchmarkRun[],
  expectedRunCount: number,
): BenchmarkMetric[] {
  if (runs.length !== expectedRunCount) {
    throw new Error(`Expected ${expectedRunCount} benchmark runs, found ${runs.length}`);
  }

  const expected = [...EXPECTED_BENCHMARK_NAMES].sort();
  const expectedSet = new Set<string>(expected);
  const metrics: BenchmarkMetric[] = [];
  for (const run of runs) {
    const actual = run.metrics.map((metric) => metric.name).sort();
    if (actual.join("\n") !== expected.join("\n")) {
      const missing = expected.filter((name) => !actual.includes(name));
      const unexpected = actual.filter((name) => !expectedSet.has(name));
      throw new Error(
        `Benchmark run ${run.name} has an incomplete metric set; missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
      );
    }
    metrics.push(...run.metrics);
  }
  return metrics;
}

function collectJsonFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files.sort();
}

function isBenchmarkMetric(value: unknown): value is BenchmarkMetric {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "unit" in value &&
    "value" in value &&
    typeof value.name === "string" &&
    value.unit === "ns/op" &&
    typeof value.value === "number" &&
    Number.isFinite(value.value)
  );
}

function summarizeMetrics(metrics: readonly BenchmarkMetric[]): BenchmarkStats[] {
  const groups = new Map<string, BenchmarkMetric[]>();
  for (const metric of metrics) {
    const group = groups.get(metric.name);
    if (group) group.push(metric);
    else groups.set(metric.name, [metric]);
  }

  return [...groups.entries()]
    .map(([name, group]) => {
      const values = group.map((metric) => metric.value).sort((left, right) => left - right);
      return {
        name,
        unit: "ns/op" as const,
        value: percentile(values, 50),
        runs: values.length,
        mean: mean(values),
        min: values[0] ?? 0,
        max: values.at(-1) ?? 0,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function toGateMetrics(stats: readonly BenchmarkStats[]): BenchmarkMetric[] {
  return stats.map((metric) => ({ name: metric.name, unit: metric.unit, value: Math.round(metric.p50) }));
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const rank = (percentileValue / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedValues[lowerIndex] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function renderSummary(stats: readonly BenchmarkStats[]): string {
  const rows = stats.map(
    (metric) =>
      `| ${metric.name} | ${metric.runs} | ${format(metric.p50)} | ${format(metric.p95)} | ${format(metric.mean)} | ${format(metric.min)} | ${format(metric.max)} |`,
  );
  return [
    "# Benchmark Summary",
    "",
    "The CI gate compares the p50 column through github-action-benchmark. Tail latency remains visible in p95.",
    "",
    "| Benchmark | Runs | p50 ns/op | p95 ns/op | mean ns/op | min ns/op | max ns/op |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

function format(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  });
}
