import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EXPECTED_BENCHMARK_NAMES, validateBenchmarkRuns } from "../summarize-benchmark-runs";

function completeRun(name: string) {
  return {
    name,
    metrics: EXPECTED_BENCHMARK_NAMES.map((metricName) => ({
      name: metricName,
      unit: "ns/op" as const,
      value: 1,
    })),
  };
}

describe("benchmark run aggregation", () => {
  test("validates the complete repeat-count input without collecting samples", () => {
    for (const value of ["5", "0", "-1", "5garbage", "1.5", "", "9007199254740992"]) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          new URL("../summarize-benchmark-runs.ts", import.meta.url).pathname,
          "--validate-input",
        ],
        {
          env: { ...process.env, BENCHMARK_RUNS: value },
          stdin: "ignore",
          timeout: 5000,
        },
      );
      expect(result.exitCode).toBe(value === "5" ? 0 : 1);
      if (value !== "5") {
        expect(result.stderr.toString()).toContain("BENCHMARK_RUNS must be a positive integer");
      }
    }
  });

  test("reference runs accept a consistent subset but head runs remain complete", () => {
    const runs = [completeRun("1"), completeRun("2")].map((run) => ({ ...run, metrics: run.metrics.slice(0, 14) }));
    expect(validateBenchmarkRuns(runs, 2, "reference")).toHaveLength(28);
    expect(() => validateBenchmarkRuns(runs, 2)).toThrow(Error);
    expect(validateBenchmarkRuns([completeRun("1")], 1, "reference")).toHaveLength(22);
  });

  test("reference runs reject foreign, duplicate, empty and inconsistent metric sets", () => {
    const run = completeRun("1");
    const subset = { ...run, metrics: run.metrics.slice(0, 14) };
    for (const name of ["foreign", EXPECTED_BENCHMARK_NAMES[0]]) {
      const invalid = { ...subset, metrics: [...subset.metrics, { name, unit: "ns/op" as const, value: 1 }] };
      expect(() => validateBenchmarkRuns([invalid], 1, "reference")).toThrow(Error);
    }
    expect(() => validateBenchmarkRuns([{ ...run, metrics: [] }], 1, "reference")).toThrow(Error);
    expect(() => validateBenchmarkRuns([subset, run], 2, "reference")).toThrow(Error);
    expect(() => validateBenchmarkRuns([run, subset], 2, "reference")).toThrow(Error);
    expect(() => validateBenchmarkRuns([subset], 2, "reference")).toThrow(Error);
  });

  test("CLI summarizes older reference runs only with explicit reference mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "benchmark-summary-"));
    const cli = new URL("../summarize-benchmark-runs.ts", import.meta.url).pathname;
    const invoke = (args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], {
      cwd: root, env: { ...process.env, BENCHMARK_RUNS: "2" }, stdin: "ignore", timeout: 5000,
    });
    try {
      const subset = completeRun("1").metrics.slice(0, 14);
      for (const run of ["1", "2"]) {
        await Bun.write(join(root, "runs", run, "ledger", "metrics.json"), JSON.stringify(subset));
        await Bun.write(join(root, "runs", run, "ignored.txt"), "not benchmark data");
      }
      const outputs = ["runs", "out/combined.json", "out/statistics.json", "out/summary.md"];
      expect(invoke(outputs).exitCode).toBe(1);
      const result = invoke(["--reference", ...outputs]);
      expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
      const Metric = z.object({ name: z.string(), unit: z.literal("ns/op"), value: z.number() });
      const combined = z.array(Metric).parse(await Bun.file(join(root, "out/combined.json")).json());
      expect(combined).toEqual([...subset].sort((left, right) => left.name.localeCompare(right.name)));
      const stats = z.array(Metric.extend({ runs: z.number(), p50: z.number() })).parse(await Bun.file(join(root, "out/statistics.json")).json());
      expect(stats).toEqual(combined.map((metric) => ({ ...metric, runs: 2, p50: 1 })));
      expect(await Bun.file(join(root, "out/summary.md")).exists()).toBe(true);
      for (const invalid of [{}, [{ name: "invalid", unit: "ms/op", value: 1 }]]) {
        await Bun.write(join(root, "runs/1/ledger/metrics.json"), JSON.stringify(invalid));
        expect(invoke(["--reference", ...outputs]).exitCode).toBe(1);
      }
      for (const run of ["1", "2"]) {
        await Bun.write(join(root, "bench-results/runs", run, "metrics.json"), JSON.stringify(completeRun(run).metrics));
      }
      expect(invoke([]).exitCode).toBe(0);
      mkdirSync(join(root, "invalid-root"));
      await Bun.write(join(root, "invalid-root/file.json"), "[]");
      expect(invoke(["invalid-root"]).exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires the expected run count", () => {
    expect(() => validateBenchmarkRuns([completeRun("1")], 2)).toThrow(
      "Expected 2 benchmark runs, found 1",
    );
  });

  test("requires every expected metric exactly once in every run", () => {
    const incomplete = completeRun("1");
    expect(() =>
      validateBenchmarkRuns(
        [{ ...incomplete, metrics: incomplete.metrics.slice(1) }, completeRun("2")],
        2,
      ),
    ).toThrow("incomplete metric set");

    for (const name of [EXPECTED_BENCHMARK_NAMES[0], "unexpected"]) {
      expect(() =>
        validateBenchmarkRuns(
          [{ ...incomplete, metrics: [...incomplete.metrics, { name, unit: "ns/op", value: 1 }] }],
          1,
        ),
      ).toThrow("incomplete metric set");
    }

    expect(validateBenchmarkRuns([completeRun("1"), completeRun("2")], 2)).toHaveLength(
      EXPECTED_BENCHMARK_NAMES.length * 2,
    );
  });
});
