import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCoverage, parseLcovSummary } from "./check-coverage-ratchet";
import { coverageLanes } from "./topology";

const record = (file = "src/covered.ts", found = "10000", hit = found) =>
  `SF:${file}\nLF:${found}\nLH:${hit}\nend_of_record\n`;

test("LCOV rejects malformed counts and incomplete records", () => {
  for (const [found, hit] of [
    ["NaN", "1"],
    ["Infinity", "1"],
    ["-1", "0"],
    ["1.5", "1"],
    ["1", "2"],
    ["", "0"],
  ]) {
    expect(() => parseLcovSummary(record("src/a.ts", found, hit))).toThrow();
  }
  for (const text of [
    "SF:src/a.ts\nLF:1\nend_of_record\n",
    "SF:src/a.ts\nLF:1\nLH:1\n",
    record() + record(),
  ]) {
    expect(() => parseLcovSummary(text)).toThrow();
  }
});

test("baseline counters and percentage are validated without changing reviewed floors", () => {
  const current = { lane: { linesFound: 10, linesHit: 9, pct: 90 } };
  for (const coverage of [
    { linesFound: Number.NaN, linesHit: 9, pct: 90 },
    { linesFound: 10, linesHit: -1, pct: 90 },
    { linesFound: 10, linesHit: 11, pct: 90 },
    { linesFound: 10, linesHit: 9, pct: Number.NaN },
    { linesFound: 10, linesHit: 9, pct: 101 },
  ])
    expect(() => compareCoverage({ lane: coverage }, current, 0.5)).toThrow();
  expect(
    compareCoverage({ lane: { linesFound: 10, linesHit: 9, pct: 91 } }, current, 0.5).violations,
  ).toHaveLength(1);
});

function fixture(
  run: (root: string, cli: (...args: string[]) => ReturnType<typeof Bun.spawnSync>) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "coverage-ratchet-test-"));
  const put = (path: string, content: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    put(
      "script/conformance/coverage-baseline.json",
      readFileSync(join(import.meta.dir, "conformance/coverage-baseline.json"), "utf8"),
    );
    for (const lane of coverageLanes()) {
      const source = lane.sourceRoot === "." ? "covered.ts" : "src/covered.ts";
      put(`${lane.dir}/${source}`, "export const covered = 1;\n");
      put(`${lane.dir}/coverage/lcov.info`, record(source));
    }
    const cli = (...args: string[]) =>
      Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "check-coverage-ratchet.ts"), ...args],
        { cwd: root },
      );
    run(root, cli);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("full check/update fail closed on empty instrumentation without rewriting baseline", () =>
  fixture((root, cli) => {
    const baseline = join(root, "script/conformance/coverage-baseline.json");
    const before = readFileSync(baseline, "utf8");
    expect(cli().exitCode).toBe(0);
    const reportPath = join(root, "packages/llm/coverage/lcov.info");
    for (const report of ["", record("src/covered.ts", "0", "0")]) {
      writeFileSync(reportPath, report);
      expect(cli().exitCode).not.toBe(0);
      expect(cli("--update").exitCode).not.toBe(0);
      expect(readFileSync(baseline, "utf8")).toBe(before);
    }
    writeFileSync(reportPath, record("src/covered.ts", "10000", "1"));
    expect(cli().exitCode).not.toBe(0);
    expect(cli("--update").exitCode).toBe(0);
    expect(cli().exitCode).toBe(0);
  }));

test("selected lane requires exactly its report and ignores unrelated reports", () =>
  fixture((root, cli) => {
    for (const lane of coverageLanes()) {
      if (lane.dir !== "packages/llm")
        rmSync(join(root, lane.dir, "coverage"), { recursive: true });
    }
    mkdirSync(join(root, "packages/machines/coverage"), { recursive: true });
    writeFileSync(join(root, "packages/machines/coverage/lcov.info"), "invalid");
    expect(cli("--lane", "packages/llm").exitCode).toBe(0);
    expect(cli().exitCode).not.toBe(0);
    for (const args of [
      ["--lane"],
      ["--lane", "packages/machines"],
      ["--lane", "bogus"],
      ["--lane", "packages/llm", "--update"],
    ])
      expect(cli(...args).exitCode).not.toBe(0);
    rmSync(join(root, "packages/llm/coverage/lcov.info"));
    expect(cli("--lane", "packages/llm").exitCode).not.toBe(0);
  }));

test("real Bun omission is rejected in check and update; type-only files are exempt", () =>
  fixture((root, cli) => {
    const lane = join(root, "packages/llm");
    writeFileSync(join(lane, "src/index.ts"), 'export { covered } from "./covered";\n');
    writeFileSync(join(lane, "src/unimported.tsx"), "export const unimported = () => 2;\n");
    writeFileSync(
      join(lane, "src/types.ts"),
      "export interface Shape { value: number }\nexport type Value = number;\n",
    );
    writeFileSync(join(lane, "src/ambient.d.ts"), "declare const ambient: number;\n");
    writeFileSync(
      join(lane, "covered.test.ts"),
      'import { expect, test } from "bun:test"; import { covered } from "./src/covered"; test("covered", () => expect(covered).toBe(1));\n',
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        "test",
        "--coverage",
        "--coverage-reporter=lcov",
        "--coverage-dir=coverage",
      ],
      { cwd: lane },
    );
    expect(result.exitCode).toBe(0);
    const report = readFileSync(join(lane, "coverage/lcov.info"), "utf8");
    expect(report).toContain("SF:src/covered.ts");
    expect(report).not.toContain("SF:src/unimported.tsx");
    // Keep the historical denominator control independent of the omitted file.
    const baselinePath = join(root, "script/conformance/coverage-baseline.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<
      string,
      { linesFound: number; linesHit: number; pct: number }
    >;
    baseline["packages/llm"] = { linesFound: 1, linesHit: 1, pct: 100 };
    writeFileSync(baselinePath, JSON.stringify(baseline));
    for (const args of [[], ["--update"], ["--lane", "packages/llm"]]) {
      const checked = cli(...args);
      expect(checked.exitCode).not.toBe(0);
      expect(checked.stderr?.toString()).toContain("src/unimported.tsx");
    }
    rmSync(join(lane, "src/unimported.tsx"));
    expect(cli("--update").exitCode).toBe(0);
    expect(cli("--lane", "packages/llm").exitCode).toBe(0);
  }));
