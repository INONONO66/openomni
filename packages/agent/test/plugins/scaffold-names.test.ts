/**
 * #1276 acceptance: `src/plugins/` holds exactly the five directories named by
 * the check-deps five-band plugin table (imported, never re-typed), and each
 * scaffold's `index.ts` exports its own directory name — the loader key the
 * follow-up issues (#1252/#1254/#1255/#1256) assume. `compaction` is the one
 * already-real plugin; it exports its implementation instead of a scaffold
 * name and is covered by the directory-listing assertion.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AGENT_PLUGINS } from "../../../../script/check-deps";
import { name as action } from "../../src/plugins/action";
import { name as alarm } from "../../src/plugins/alarm";
import { name as hook } from "../../src/plugins/hook";
import { name as tool } from "../../src/plugins/tool";

test("#1276 src/plugins/ is exactly the check-deps five-plugin table", () => {
  const observed = readdirSync(join(import.meta.dir, "../../src/plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(observed).toEqual([...AGENT_PLUGINS].sort());
});

test("#1276 each scaffold index.ts exports its directory name from the table", () => {
  const scaffolds: ReadonlyMap<string, string> = new Map([
    ["action", action],
    ["alarm", alarm],
    ["hook", hook],
    ["tool", tool],
  ]);
  for (const plugin of AGENT_PLUGINS) {
    if (plugin === "compaction") continue;
    expect(scaffolds.get(plugin)).toBe(plugin);
  }
  expect(scaffolds.size).toBe(AGENT_PLUGINS.length - 1);
});
