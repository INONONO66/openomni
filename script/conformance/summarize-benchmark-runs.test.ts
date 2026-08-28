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

    expect(validateBenchmarkRuns([completeRun("1"), completeRun("2")], 2)).toHaveLength(
      EXPECTED_BENCHMARK_NAMES.length * 2,
    );
  });
});
