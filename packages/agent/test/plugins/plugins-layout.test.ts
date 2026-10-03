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
