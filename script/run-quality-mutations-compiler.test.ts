import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildInventory, readContract } from "./quality-inventory";
import { programs, diagnostics } from "./run-quality-mutations";

test("fallback compiler ignores untyped JavaScript inventory sources", () => {
  const root = mkdtempSync(join(tmpdir(), "mutation-fallback-"));
  try {
    writeFileSync(join(root, "tool.cjs"), "module.exports = missingName;");
    writeFileSync(join(root, "tool.mjs"), "export const value = missingName;");
    const contract: { version: 1; typescript: "5.9.2"; roots: string[]; projects: string[]; topology: false } = { version: 1, typescript: "5.9.2", roots: ["."], projects: [], topology: false };
    const inventory = buildInventory(root, contract);
    expect(diagnostics(programs(root, contract, inventory))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real mutation contract has no baseline compiler diagnostics", () => {
  const root = resolve(import.meta.dir, "..");
  const contract = readContract(resolve(root, "script/conformance/quality-contract.json"));
  expect(diagnostics(programs(root, contract, buildInventory(root, contract)))).toEqual([]);
}, 300_000);
