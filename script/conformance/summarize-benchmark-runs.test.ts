import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EXPECTED_BENCHMARK_NAMES, main, validateBenchmarkRuns } from "../summarize-benchmark-runs";

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

const originalRuns = process.env.BENCHMARK_RUNS;
const originalWrite = process.stderr.write;

afterEach(() => {
  if (originalRuns === undefined) delete process.env.BENCHMARK_RUNS;
  else process.env.BENCHMARK_RUNS = originalRuns;
  process.stderr.write = originalWrite;
});

async function invoke(args: string[], runs: string): Promise<{ code: number; stderr: string }> {
  process.env.BENCHMARK_RUNS = runs;
  let stderr = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { code: await main(args), stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe("benchmark run aggregation", () => {
  test("validates the complete repeat-count input without collecting samples", async () => {
    for (const value of ["5", "0", "-1", "5garbage", "1.5", "", "9007199254740992"]) {
      const result = await invoke(["--validate-input"], value);
      expect(result.code).toBe(value === "5" ? 0 : 1);
      expect(result.stderr).toBe(value === "5" ? "" : "ERROR: BENCHMARK_RUNS must be a positive integer\n");
    }
    expect(await invoke(["--reference", "--validate-input"], "2")).toEqual({ code: 0, stderr: "" });
  });

  test("the executable forwards the summarizer exit code to the operating system", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "summarize-benchmark-runs-cli-"));
    try {
      const results = await Promise.all(
        ["5", "0"].map(async (runs) => {
          const child = Bun.spawn(
            [process.execPath, "run", join(import.meta.dir, "..", "summarize-benchmark-runs.ts"), "--validate-input"],
            { cwd, env: { ...process.env, BENCHMARK_RUNS: runs }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          );
          const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
          return { code, stderr };
        }),
      );
      expect(results).toEqual([
        { code: 0, stderr: "" },
        { code: 1, stderr: "ERROR: BENCHMARK_RUNS must be a positive integer\n" },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
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
    const at = (relative: string) => join(root, relative);
    try {
      const subset = completeRun("1").metrics.slice(0, 14);
      for (const run of ["1", "2"]) {
        await Bun.write(at(`runs/${run}/ledger/metrics.json`), JSON.stringify(subset));
        await Bun.write(at(`runs/${run}/ignored.txt`), "not benchmark data");
      }
      const outputs = ["runs", "out/combined.json", "out/statistics.json", "out/summary.md"].map(at);
      const head = await invoke(outputs, "2");
      expect({ code: head.code, incomplete: head.stderr.includes("incomplete metric set") }).toEqual({ code: 1, incomplete: true });
      expect(await invoke(["--reference", ...outputs], "2")).toEqual({ code: 0, stderr: "" });
      const Metric = z.object({ name: z.string(), unit: z.literal("ns/op"), value: z.number() });
      const combined = z.array(Metric).parse(await Bun.file(at("out/combined.json")).json());
      expect(combined).toEqual([...subset].sort((left, right) => left.name.localeCompare(right.name)));
      const stats = z.array(Metric.extend({ runs: z.number(), p50: z.number() })).parse(await Bun.file(at("out/statistics.json")).json());
      expect(stats).toEqual(combined.map((metric) => ({ ...metric, runs: 2, p50: 1 })));
      expect(await Bun.file(at("out/summary.md")).text()).toContain(`| ${combined[0]?.name} | 2 | 1 | 1 | 1 | 1 | 1 |`);
      for (const invalid of [{}, [{ name: "invalid", unit: "ms/op", value: 1 }]]) {
        await Bun.write(at("runs/1/ledger/metrics.json"), JSON.stringify(invalid));
        expect((await invoke(["--reference", ...outputs], "2")).code).toBe(1);
      }
      mkdirSync(at("invalid-root"));
      await Bun.write(at("invalid-root/file.json"), "[]");
      const invalidRoot = await invoke([at("invalid-root"), ...outputs.slice(1)], "1");
      expect({ code: invalidRoot.code, message: invalidRoot.stderr.startsWith("ERROR: Benchmark run root contains a non-directory entry") }).toEqual({ code: 1, message: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLI defaults to the bench-results layout of the working directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "benchmark-summary-default-"));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      for (const run of ["1", "2"]) {
        await Bun.write(join(root, "bench-results/runs", run, "metrics.json"), JSON.stringify(completeRun(run).metrics));
      }
      expect(await invoke([], "2")).toEqual({ code: 0, stderr: "" });
      for (const output of ["combined.json", "statistics.json", "summary.md"]) {
        expect(await Bun.file(join(root, "bench-results", output)).exists()).toBe(true);
      }
    } finally {
      process.chdir(cwd);
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
