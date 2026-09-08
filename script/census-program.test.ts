import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { censusMain } from "./check-census";
import { census } from "./check-types-census";
import { CensusPrograms, readProject } from "./census-program";
import { buildInventory, digest, InventoryError, type Contract } from "./quality-inventory";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shared-census-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.ts"), "console.log(1);\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shared-census", private: true, scripts: { start: "bun src/main.ts" } }));
  const config = JSON.stringify({ compilerOptions: { strict: true, target: "esnext", module: "preserve", moduleResolution: "bundler", jsx: "preserve", types: [] }, files: ["src/main.ts"] });
  for (const name of ["tsconfig.json", "tsconfig.second.json"]) writeFileSync(join(root, name), config);
  const contract: Contract = { version: 1, typescript: "5.9.2", roots: ["src"], projects: ["tsconfig.json", "tsconfig.second.json"], topology: false };
  writeFileSync(join(root, "contract.json"), JSON.stringify(contract));
  return { root, contract, [Symbol.dispose]() { rmSync(root, { recursive: true, force: true }); } };
}

test("C1 shared host parses each unique file once across types and all census classes", () => {
  using input = fixture();
  const { root, contract } = input;
  const inventory = buildInventory(root, contract);
  inventory.configurations = contract.projects.map((path) => ({ path, sha256: digest(readFileSync(join(root, path))) }));
  writeFileSync(join(root, "inventory.json"), JSON.stringify(inventory));
  for (const file of ["fresh.db", "upgraded.db"]) {
    using db = new Database(join(root, file));
    db.exec("CREATE TABLE item(id INTEGER)");
  }
  const programs = new CensusPrograms();
  expect(census(root, contract, inventory, programs).complete).toBe(true);
  const knip = resolve(import.meta.dir, "../node_modules/knip/bin/knip.js");
  const argv = ["--root", root, "--json", "--class", "all", "--contract", "contract.json", "--inventory", "inventory.json", "--inventory-sha256", digest(JSON.stringify(inventory)), "--knip", knip, "--knip-sha256", digest(readFileSync(knip)), "--schema", "fresh.db", "--schema-sha256", digest(readFileSync(join(root, "fresh.db"))), "--upgraded-schema", "upgraded.db", "--upgraded-schema-sha256", digest(readFileSync(join(root, "upgraded.db")))];
  const lines: string[] = [];
  const log = console.log;
  try {
    console.log = (line: string) => { lines.push(line); };
    expect(censusMain(argv, programs)).toBe(1);
  } finally { console.log = log; }
  expect(lines).toHaveLength(3);
  expect(programs.stats.parses.size).toBeGreaterThan(1);
  expect([...programs.stats.parses.values()].every((count) => count === 1)).toBe(true);
  expect(programs.stats.programs).toBe(2);
});

test("C2 identical resolved projects dedupe, malformed and empty configs fail closed", () => {
  using input = fixture();
  const { root, contract } = input;
  const programs = new CensusPrograms();
  const first = readProject(root, "tsconfig.json");
  const second = readProject(root, "tsconfig.second.json");
  expect(programs.program(first.fileNames, first.options)).toBe(programs.program(second.fileNames, second.options));
  expect(programs.stats.programs).toBe(1);
  for (const text of ["{", '{"files":[]}', '{"include":["absent/**/*.ts"]}']) {
    writeFileSync(join(root, "tsconfig.second.json"), text);
    expect(() => readProject(root, "tsconfig.second.json")).toThrow(InventoryError);
    const result = census(root, contract, buildInventory(root, contract));
    expect(result.complete).toBe(false);
    expect(result.errors.some((error) => error.code === "config")).toBe(true);
  }
});

test("different semantic compiler options never dedupe", () => {
  using input = fixture();
  const parsed = readProject(input.root, "tsconfig.json");
  const programs = new CensusPrograms();
  const first = programs.program(parsed.fileNames, parsed.options);
  const second = programs.program(parsed.fileNames, { ...parsed.options, useUnknownInCatchVariables: false });
  expect(first).not.toBe(second);
  expect(second.getCompilerOptions().useUnknownInCatchVariables).toBe(false);
  expect(first.getSourceFile(join(input.root, "src/main.ts"))).toBe(second.getSourceFile(join(input.root, "src/main.ts")));
  expect(programs.stats.programs).toBe(2);
  expect(ts.version).toBe("5.9.2");
});

test("source-affecting options preserve module detection across shared projects", () => {
  using input = fixture();
  const parsed = readProject(input.root, "tsconfig.json");
  const programs = new CensusPrograms();
  const legacy = programs.program(parsed.fileNames, { ...parsed.options, moduleDetection: ts.ModuleDetectionKind.Legacy });
  const forced = programs.program(parsed.fileNames, { ...parsed.options, moduleDetection: ts.ModuleDetectionKind.Force });
  const file = join(input.root, "src/main.ts");
  const globalSource = legacy.getSourceFile(file);
  const moduleSource = forced.getSourceFile(file);
  expect(globalSource && ts.isExternalModule(globalSource)).toBe(false);
  expect(moduleSource && ts.isExternalModule(moduleSource)).toBe(true);
});
