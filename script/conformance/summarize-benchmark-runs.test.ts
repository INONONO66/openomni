import { describe, expect, test } from "bun:test";
import {
  EXPECTED_BENCHMARK_NAMES,
  validateBenchmarkRuns,
} from "../summarize-benchmark-runs";

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
