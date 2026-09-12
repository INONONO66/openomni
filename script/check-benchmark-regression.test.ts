import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareBenchmarks, main, readBenchmarkHistory, regressionThreshold } from "./check-benchmark-regression";
import { EXPECTED_BENCHMARK_NAMES } from "./summarize-benchmark-runs";
import { decodeJson } from "./quality-json";

const metrics = (value: number) => EXPECTED_BENCHMARK_NAMES.map((name) => ({ name, unit: "ns/op", value, p50: value, runs: 5 }));
const history = (...values: number[]) => ({ entries: { "OpenOmni Benchmarks": values.map((value, index) => ({ commit: { id: `main-${index}` }, tool: "customSmallerIsBetter", benches: metrics(value) })) } });

test("gate uses repeated-run median, latest accepted reference and strict percent boundary", () => {
  expect(compareBenchmarks(metrics(120), history(100)).failed).toBe(false);
  expect(compareBenchmarks(metrics(121), history(100)).failed).toBe(true);
  expect(compareBenchmarks(metrics(90), history(100)).failed).toBe(false);
  expect(compareBenchmarks(metrics(121), history(100), 25).failed).toBe(false);
  const current = metrics(100).map((metric) => ({ ...metric, value: 999, mean: 999 }));
  expect(compareBenchmarks(current, history(100)).failed).toBe(false);
  const result = compareBenchmarks(metrics(121), history(99, 100));
  expect(result.referenceCommit).toBe("main-1");
  expect(result.comparisons[0]?.reference).toBe(100);
  expect(result.failed).toBe(true);
});

test("a single regression fails, and a zero reference cannot hide growth", () => {
  const current = metrics(100);
  const first = current[0];
  if (!first) throw new Error("Missing test metric");
  first.p50 = 121;
  const result = compareBenchmarks(current, history(100));
  expect(result.failed).toBe(true);
  expect(result.comparisons.filter((metric) => metric.regressed)).toHaveLength(1);
  expect(compareBenchmarks(metrics(0), history(0)).failed).toBe(false);
  expect(compareBenchmarks(metrics(1), history(0)).failed).toBe(true);
});

test("regression must also exceed two historical sample standard deviations", () => {
  const noisy = history(50, 150, 100);
  expect(compareBenchmarks(metrics(121), noisy).failed).toBe(false);
  expect(compareBenchmarks(metrics(200), noisy).failed).toBe(false);
  const result = compareBenchmarks(metrics(201), noisy);
  expect(result.comparisons[0]?.noiseBand).toBe(100);
  expect(result.failed).toBe(true);
  expect(compareBenchmarks(metrics(121), history(10000, ...Array.from({ length: 20 }, () => 100))).failed).toBe(true);
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("invalid metric value %s fails closed", (value) => {
  expect(() => compareBenchmarks(metrics(value), history(100))).toThrow();
});

test("invalid input and incomplete references fail closed", () => {
  for (const input of ["", "0", "-1", "NaN", "Infinity", "20%"])
    expect(() => regressionThreshold(input)).toThrow();
  expect(regressionThreshold()).toBe(20);
  expect(regressionThreshold("12.5")).toBe(12.5);
  expect(() => compareBenchmarks([], history(100))).toThrow();
  expect(() => compareBenchmarks([...metrics(100), ...metrics(100)], history(100))).toThrow();
  expect(() => compareBenchmarks(metrics(100), history())).toThrow();
  const missing = history(100);
  missing.entries["OpenOmni Benchmarks"][0]?.benches.pop();
  expect(() => compareBenchmarks(metrics(100), missing)).toThrow();
  const duplicate = history(100);
  duplicate.entries["OpenOmni Benchmarks"][0]?.benches.push(...metrics(100));
  expect(() => compareBenchmarks(metrics(100), duplicate)).toThrow();
  const wrongUnit = metrics(100).map((metric) => ({ ...metric, unit: "ms/op" }));
  expect(() => compareBenchmarks(wrongUnit, history(100))).toThrow();
});

test("gh-pages wrapper is parsed as data, never evaluated", () => {
  const data = history(100);
  expect(readBenchmarkHistory(`window.BENCHMARK_DATA = ${JSON.stringify(data)};\n`)).toEqual(data);
  expect(readBenchmarkHistory(JSON.stringify(data))).toEqual(data);
  expect(() => readBenchmarkHistory("window.BENCHMARK_DATA = process.exit(0)")).toThrow();
  expect(() => readBenchmarkHistory("window.BENCHMARK_DATA = {}; process.exit(0)")).toThrow();
  expect(() => readBenchmarkHistory('window.BENCHMARK_DATA = {"entries":{},"entries":{}}')).toThrow();
});

test("CLI exposes failing status, artifact and job summary without changing the reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-gate-"));
  const cwd = process.cwd(), env = { ...process.env };
  try {
    process.chdir(root);
    mkdirSync(join(root, "bench-results"));
    const reference = `window.BENCHMARK_DATA = ${JSON.stringify(history(100))}`;
    await Bun.write(join(root, "bench-results/reference.js"), reference);
    await Bun.write(join(root, "bench-results/statistics.json"), JSON.stringify(metrics(121)));
    const summary = join(root, "summary.md");
    const cli = join(import.meta.dir, "check-benchmark-regression.ts");
    process.env.GITHUB_STEP_SUMMARY = summary;
    expect(await main(["--validate-input"])).toBe(0);
    for (const [threshold, exit] of [["20", 1], ["25", 0]] as const) {
      const child = Bun.spawn([process.execPath, cli], { cwd: root, env: { ...process.env, BENCHMARK_REGRESSION_PERCENT: threshold, GITHUB_STEP_SUMMARY: summary }, stdout: "ignore", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(exit);
      process.env.BENCHMARK_REGRESSION_PERCENT = threshold;
      expect(await main([])).toBe(exit);
      const result = decodeJson(await Bun.file(join(root, "bench-results/regression.json")).text());
      expect(result).toMatchObject({ failed: exit === 1, referenceCommit: "main-0" });
    }
    expect(await Bun.file(summary).exists()).toBe(true);
    expect(await Bun.file(join(root, "bench-results/reference.js")).text()).toBe(reference);
    const validate = Bun.spawn([process.execPath, cli, "--validate-input"], { cwd: root, env: { ...process.env, BENCHMARK_REGRESSION_PERCENT: "20" }, stdout: "ignore", stderr: "pipe" });
    expect(await validate.exited).toBe(0);
  } finally {
    process.chdir(cwd);
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
