import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedLines,
  checkPatchCoverage,
  gatedPath,
  lcovPrefix,
  lcovUnion,
  main,
  uncoveredRows,
} from "./check-patch-coverage";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

test("gatedPath admits product src and tooling, refuses tests and docs", () => {
  expect(gatedPath("packages/agent/src/executor.ts")).toBe(true);
  expect(gatedPath("apps/openomni/src/cli/daemon.ts")).toBe(true);
  expect(gatedPath("script/check-deps.ts")).toBe(true);
  expect(gatedPath("script/check-deps.test.ts")).toBe(false);
  expect(gatedPath("packages/agent/src/executor.test.ts")).toBe(false);
  expect(gatedPath("packages/agent/test/helper.ts")).toBe(false);
  expect(gatedPath("script/quality-metrics/tool.ts")).toBe(false);
  expect(gatedPath("docs/ci.md")).toBe(false);
});

test("lcovPrefix maps artifact layouts to repo prefixes", () => {
  expect(lcovPrefix("cov/coverage-agent/packages/agent/coverage/lcov.info")).toBe("packages/agent");
  expect(lcovPrefix("cov/coverage-x/apps/openomni/coverage/lcov.info")).toBe("apps/openomni");
  expect(lcovPrefix("cov/coverage-scripts-tooling-1/script/coverage/lcov.info")).toBe("script");
  expect(lcovPrefix("packages/agent/coverage/lcov.info")).toBe("packages/agent");
});

test("changedLines keeps only gated files with unified-0 hunks", () => {
  const diff = [
    "diff --git a/packages/agent/src/a.ts b/packages/agent/src/a.ts",
    "--- a/packages/agent/src/a.ts",
    "+++ b/packages/agent/src/a.ts",
    "@@ -1,2 +10,3 @@",
    "@@ -9 +20 @@",
    "--- a/docs/ci.md",
    "+++ b/docs/ci.md",
    "@@ -1 +1,5 @@",
  ].join("\n");
  const changed = changedLines(diff);
  expect([...changed.keys()]).toEqual(["packages/agent/src/a.ts"]);
  expect([...(changed.get("packages/agent/src/a.ts") ?? [])]).toEqual([10, 11, 12, 20]);
});

test("uncovered rows: zero-hit lines fail, unknown lines are not executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-lcov-"));
  try {
    mkdirSync(join(dir, "packages/agent/coverage"), { recursive: true });
    mkdirSync(join(dir, "script/coverage"), { recursive: true });
    writeFileSync(
      join(dir, "packages/agent/coverage/lcov.info"),
      "SF:src/a.ts\nDA:10,0\nDA:11,3\nend_of_record\n",
    );
    writeFileSync(
      join(dir, "script/coverage/lcov.info"),
      "SF:check-thing.ts\nDA:5,0\nend_of_record\n",
    );
    const union = lcovUnion(
      [join(dir, "packages/agent/coverage/lcov.info"), join(dir, "script/coverage/lcov.info")],
      dir,
    );
    const changed = new Map([
      ["packages/agent/src/a.ts", new Set([10, 11, 12])],
      ["script/check-thing.ts", new Set([5])],
      ["packages/agent/src/unknown.ts", new Set([1])],
    ]);
    expect(uncoveredRows(changed, union)).toEqual([
      "packages/agent/src/a.ts:10",
      "script/check-thing.ts:5",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lcov union takes the maximum hits across shards", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-union-"));
  try {
    mkdirSync(join(dir, "a/script/coverage"), { recursive: true });
    mkdirSync(join(dir, "b/script/coverage"), { recursive: true });
    writeFileSync(join(dir, "a/script/coverage/lcov.info"), "SF:x.ts\nDA:1,0\nDA:2,2\n");
    writeFileSync(join(dir, "b/script/coverage/lcov.info"), "SF:x.ts\nDA:1,7\nDA:2,0\n");
    const union = lcovUnion(
      [join(dir, "a/script/coverage/lcov.info"), join(dir, "b/script/coverage/lcov.info")],
      dir,
    );
    expect(union.get("script/x.ts")?.get(1)).toBe(7);
    expect(union.get("script/x.ts")?.get(2)).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end against a fixture repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-repo-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "qa@example.com");
    git(dir, "config", "user.name", "qa");
    mkdirSync(join(dir, "packages/kit/src"), { recursive: true });
    writeFileSync(join(dir, "packages/kit/src/sum.ts"), "export const sum = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(
      join(dir, "packages/kit/src/sum.ts"),
      "export const sum = 1;\nexport const covered = 2;\nexport const uncovered = 3;\nexport type OnlyType = number;\n",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "change");
    mkdirSync(join(dir, "packages/kit/coverage"), { recursive: true });
    writeFileSync(
      join(dir, "packages/kit/coverage/lcov.info"),
      "SF:src/sum.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n",
    );
    const rows = checkPatchCoverage(base, ["packages/*/coverage/lcov.info"], dir);
    expect(rows).toEqual(["packages/kit/src/sum.ts:3"]);
    const glob = ["--glob", "packages/*/coverage/lcov.info"];
    expect(main(["--base", base, ...glob], dir)).toBe(1);
    writeFileSync(
      join(dir, "packages/kit/coverage/lcov.info"),
      "SF:src/sum.ts\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n",
    );
    expect(main(["--base", base, ...glob], dir)).toBe(0);
    expect(() => main([], dir)).toThrow("usage:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
