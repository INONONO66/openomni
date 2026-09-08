import { expect, test } from "bun:test";
import { scriptsLanes, scriptTests } from "./scripts-lanes";

test("every recursive script test belongs to exactly one explicit lane", () => {
  const root = import.meta.dir;
  const actual = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: root })].sort();
  const assigned = Object.values(scriptsLanes).flat().sort();
  expect(actual).toEqual(assigned);
  expect(new Set(assigned).size).toBe(assigned.length);
  expect(() => scriptTests("scripts-contracts", [...actual, "unclassified.test.ts"])).toThrow("unclassified.test.ts");
  expect(scriptTests("scripts-tooling", actual)).toEqual(scriptsLanes["scripts-tooling"]);
});
