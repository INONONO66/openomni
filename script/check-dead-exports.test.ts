import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareDeadExports,
  normalizeKnipIssues,
  productionConsumerFindings,
  readBaseline,
  runKnip,
} from "./check-dead-exports";

const ROOT = join(import.meta.dir, "..");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

test("member issues normalize to stable Parent.name keys and duplicates flatten", () => {
  expect(
    normalizeKnipIssues({
      issues: [
        {
          file: "packages/fixture/src/index.ts",
          enumMembers: { Mode: [{ name: "LEGACY", line: 12, col: 3 }] },
          namespaceMembers: { Api: [{ name: "orphan", line: 20, col: 3 }] },
          duplicates: [[{ name: "twin" }, { name: "twin" }]],
        },
        { file: "packages/fixture/src/orphan.ts", files: [{ name: "orphan.ts" }] },
      ],
    }),
  ).toEqual([
    "duplicates packages/fixture/src/index.ts twin",
    "enumMembers packages/fixture/src/index.ts Mode.LEGACY",
    "files packages/fixture/src/orphan.ts",
    "namespaceMembers packages/fixture/src/index.ts Api.orphan",
  ]);
});

test("runKnip refuses a knip.json whose workspaces drift from the topology", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "openomni-knip-inventory-"));
  fixtures.push(fixture);
  await writeFile(join(fixture, "knip.json"), `${JSON.stringify({ workspaces: { bogus: {} } })}\n`);
  const cwd = process.cwd();
  process.chdir(fixture);
  try {
    await expect(runKnip(".")).rejects.toThrow("knip workspace topology drift");
  } finally {
    process.chdir(cwd);
  }
});

test("census projection keeps only exports without a production consumer", () => {
  const consumed = {
    definition: { path: "packages/agent/src/used.ts", line: 4, symbol: "used" },
    consumers: [{ role: "production" as const }],
  };
  const testOnly = {
    definition: { path: "packages/agent/src/idle.ts", line: 9, symbol: "idle" },
    consumers: [{ role: "test" as const }, { role: "barrel" as const }],
  };
  expect(productionConsumerFindings([consumed, testOnly])).toEqual([
    { path: "packages/agent/src/idle.ts", line: 9, symbol: "idle", class: "export" },
  ]);
});

test("the shipped baseline parses and compares clean against itself", () => {
  const cwd = process.cwd();
  process.chdir(ROOT);
  try {
    const baseline = readBaseline();
    const onDisk: unknown = JSON.parse(
      readFileSync(join(ROOT, "script/conformance/knip-baseline.json"), "utf8"),
    );
    expect(onDisk).toEqual({ grandfathered: [...baseline.grandfathered] });
    expect(compareDeadExports(baseline.grandfathered, baseline.grandfathered)).toEqual({
      newIssues: [],
      resolved: [],
    });
  } finally {
    process.chdir(cwd);
  }
});
