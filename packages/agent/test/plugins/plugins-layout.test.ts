/**
 * #1276 layout contract (review r3 F3, lead disposition): `src/plugins/` holds
 * exactly the directories named by the check-deps five-plugin table (imported,
 * never re-typed — no handwritten directory literals here), and each listed
 * directory's `index.ts` exports its own directory name — the loader key the
 * follow-up issues (#1252/#1254/#1255/#1256) assume. This test is the
 * exports' consumer until those land.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AGENT_PLUGINS } from "../../../../script/check-deps";

const pluginsDir = join(import.meta.dir, "../../src/plugins");

function listedPlugins(): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("#1276 src/plugins/ is exactly the check-deps five-plugin table", () => {
  expect(listedPlugins()).toEqual([...AGENT_PLUGINS].sort());
});

test("#1276 each listed plugin's index.ts exports its directory name as the loader key", async () => {
  for (const dir of listedPlugins()) {
    const plugin: { name?: string } = await import(join(pluginsDir, dir, "index.ts"));
    expect(plugin.name).toBe(dir);
  }
});
