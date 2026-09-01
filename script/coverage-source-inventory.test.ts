import { expect, test } from "bun:test";

const ownedSources = [...new Bun.Glob("*.ts").scanSync({ cwd: import.meta.dir, onlyFiles: true })]
  .filter((file) => !file.endsWith(".test.ts"))
  .sort();

test("every owned script source is loaded for coverage", async () => {
  for (const source of ownedSources) {
    await import(new URL(source, `${import.meta.url}/../`).href);
  }

  expect(ownedSources.length).toBeGreaterThan(0);
});
