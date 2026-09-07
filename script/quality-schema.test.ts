import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { liveCensusTables } from "./ledger-producer-manifest";
import { qualitySchemas } from "./quality-schema";

test("census schemas are equal after real fresh initialization and native guarded upgrade", () => {
  const directory = mkdtempSync(join(tmpdir(), "quality-schema-"));
  try {
    const result = qualitySchemas(resolve(import.meta.dir, ".."), directory);
    using fresh = new Database(result.fresh, { readonly: true });
    using upgraded = new Database(result.upgraded);
    const schema = liveCensusTables(fresh);
    expect(schema.length).toBeGreaterThan(0);
    expect(liveCensusTables(upgraded)).toEqual(schema);
    upgraded.run("CREATE TABLE unowned_mutant (id INTEGER)");
    expect(liveCensusTables(upgraded)).not.toEqual(schema);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
