import { expect, test } from "bun:test";
import { scriptPartitions, scriptTestCommand, scriptTests, scriptToolingPartitions, scriptsLanes } from "./scripts-lanes";

test("every recursive script test belongs to exactly one explicit lane", () => {
  const root = import.meta.dir;
  const actual = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: root })].sort();
  const assigned = Object.values(scriptsLanes).flat().sort();
  expect(actual).toEqual(assigned);
  expect(new Set(assigned).size).toBe(assigned.length);
  expect(() => scriptTests("scripts-contracts", [...actual, "unclassified.test.ts"])).toThrow("unclassified.test.ts");
  expect(scriptTests("scripts-tooling", actual)).toEqual(scriptsLanes["scripts-tooling"]);
  const partitioned = Object.values(scriptToolingPartitions).flat();
  expect(new Set(partitioned).size).toBe(partitioned.length);
  expect([...partitioned].sort()).toEqual([...scriptsLanes["scripts-tooling"]].sort());
  expect(Object.keys(scriptToolingPartitions)).toEqual(scriptPartitions.filter((key) => key !== "scripts-contracts"));
});

test("shard commands execute each assigned test exactly once without hash sharding", () => {
  const selected = scriptPartitions.flatMap((partition) => {
    const command = scriptTestCommand(partition);
    expect(command.some((arg) => arg.startsWith("--shard"))).toBe(false);
    return command.filter((arg) => arg.endsWith(".test.ts")).map((arg) => arg.slice(2));
  });
  expect(selected.sort()).toEqual([...new Bun.Glob("**/*.test.ts").scanSync({ cwd: import.meta.dir })].sort());
  expect(() => scriptTestCommand("scripts-tooling-4")).toThrow("invalid script partition");
});
