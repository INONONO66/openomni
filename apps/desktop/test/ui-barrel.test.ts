import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * `@openomni/ui`'s barrel exports exactly what this app imports. An export
 * nobody here names is dead surface the design system is carrying for no
 * consumer; the ratchet is this test, not a baseline.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");
const BARREL = join(ROOT, "packages", "ui", "src", "index.ts");

/** Every exported name in the barrel, type or value. */
function exportedNames(barrel: string): string[] {
  const names: string[] = [];
  for (const block of barrel.matchAll(/export (?:type )?\{([^}]+)\}/g)) {
    for (const entry of block[1]?.split(",") ?? []) {
      const name = entry
        .trim()
        .replace(/^type /, "")
        .replace(/ as .*$/, "");
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

/** The names this app imports from the barrel, across src and test. */
async function importedNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const glob = new Glob("{src,test}/**/*.{ts,tsx}");
  for await (const path of glob.scan({ cwd: join(ROOT, "apps", "desktop"), absolute: true })) {
    const text = await Bun.file(path).text();
    for (const block of text.matchAll(/import (?:type )?\{([^}]+)\} from "@openomni\/ui"/g)) {
      for (const entry of block[1]?.split(",") ?? []) {
        const name = entry
          .trim()
          .replace(/^type /, "")
          .replace(/ as .*$/, "");
        if (name.length > 0) names.add(name);
      }
    }
  }
  return names;
}

describe("the ui barrel", () => {
  test("Given every export of @openomni/ui, When the app is read, Then each one is imported here", async () => {
    const exported = exportedNames(await Bun.file(BARREL).text());
    expect(exported.length).toBeGreaterThan(0);
    const imported = await importedNames();
    expect(exported.filter((name) => !imported.has(name))).toEqual([]);
  });
});
