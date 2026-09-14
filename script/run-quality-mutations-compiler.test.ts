import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildInventory, readContract } from "./quality-inventory";
import { programs, diagnostics, executionTreeHash, sha256 } from "./run-quality-mutations";
import { FrozenMutationCompiler, MutationCompilerWorker } from "./quality-mutation-compiler";

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

function compilerFixture() {
  const root = mkdtempSync(join(tmpdir(), "mutation-incremental-"));
  const files = {
    "a/value.ts": "export const value = 1;",
    "a/global.ts": "interface CampaignGlobal { value: number }",
    "b/consumer.ts": 'import { value } from "../a/value"; export const result: number = value; const global: CampaignGlobal = { value: 1 };',
    "c/independent.ts": "export const independent = true;",
    "fallback.ts": 'import { value } from "./a/value"; export const fallback: number = value;',
    "ignored.cjs": "module.exports = missingName;",
  };
  for (const directory of ["a", "b", "c"]) mkdirSync(join(root, directory));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  for (const [directory, include] of [["a", ["."]], ["b", [".", "../a/global.ts"]], ["c", ["."]]] as const)
    writeFileSync(join(root, directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: [], skipLibCheck: true }, include }));
  const contract = { version: 1 as const, typescript: "5.9.2" as const, roots: ["."], projects: ["a/tsconfig.json", "b/tsconfig.json", "c/tsconfig.json"], topology: false as const };
  const inventory = buildInventory(root, contract);
  const identity = executionTreeHash(root);
  return { root, files, contract, inventory, identity };
}

function compilerRequest(root: string, identity: string, path: string, content: string) {
  return { executionTreeSha256: identity, candidateId: sha256(`${path}\0${content}`), path, originalSha256: sha256(readFileSync(join(root, path))), sourceSha256: sha256(content), content };
}

test("incremental compiler matches the cold oracle through stale-state, consumer, global and fallback changes", () => {
  const input = compilerFixture();
  try {
    const compiler = new FrozenMutationCompiler(input.root, input.contract, input.inventory, input.identity);
    const cases = [
      ["a/value.ts", "export const value = 2;"],
      ["a/value.ts", 'export const value = "wrong";'],
      ["a/value.ts", "export const value = false;"],
      ["a/value.ts", input.files["a/value.ts"]],
      ["a/global.ts", "interface CampaignGlobal { value: string }"],
      ["a/global.ts", input.files["a/global.ts"]],
      ["fallback.ts", "export const fallback: number = false;"],
      ["ignored.cjs", "module.exports = anotherMissingName;"],
      // Changing native dependency membership also changes fallback ownership.
      ["c/independent.ts", 'export { fallback } from "../fallback";'],
      ["c/independent.ts", input.files["c/independent.ts"]],
      // Keep the same active checker through distinct errors and restoration.
      ["c/independent.ts", "export const independent: number = 1;"],
      ["c/independent.ts", "export const independent: number = false;"],
      ["c/independent.ts", 'export const independent: number = "wrong";'],
      ["c/independent.ts", "export const independent: number = 1;"],
    ];
    for (const [path, content] of cases) {
      if (!path || !content) throw new Error("Missing compiler test case");
      const request = compilerRequest(input.root, input.identity, path, content);
      const checked = compiler.check(request);
      const original = readFileSync(join(input.root, path), "utf8");
      let cold: string[];
      try {
        writeFileSync(join(input.root, path), content);
        cold = diagnostics(programs(input.root, input.contract, input.inventory));
      } finally { writeFileSync(join(input.root, path), original); }
      expect(checked.diagnostics).toEqual(cold);
      expect(checked.valid).toBe(cold.length === 0);
      expect(checked.diagnosticsSha256).toBe(sha256(JSON.stringify(cold)));
      expect(checked.candidateId).toBe(request.candidateId);
      expect(checked.sourceSha256).toBe(request.sourceSha256);
      expect(checked.executionTreeSha256).toBe(input.identity);
      expect(checked.projects.map((project) => project.project)).toEqual([...input.contract.projects, "inventory-fallback"]);
      if (content.startsWith("export const independent: number"))
        expect(checked.projects.find((project) => project.project === "c/tsconfig.json")?.mode).toBe("incremental");
      if (path === "a/value.ts") {
        expect(checked.projects.filter((project) => project.mode !== "frozen").map((project) => project.project)).toEqual(["a/tsconfig.json", "b/tsconfig.json", "inventory-fallback"]);
        if (content.includes("wrong")) {
          expect(cold.some((diagnostic) => diagnostic.includes("consumer.ts"))).toBe(true);
          expect(cold.some((diagnostic) => diagnostic.includes("fallback.ts"))).toBe(true);
        }
      }
    }
    const first = compiler.check(compilerRequest(input.root, input.identity, "c/independent.ts", "export const independent = false;"));
    const second = compiler.check(compilerRequest(input.root, input.identity, "c/independent.ts", "export const independent = true;"));
    expect(first.projects.find((project) => project.project === "c/tsconfig.json")?.mode).toBe("incremental");
    expect(second.projects.find((project) => project.project === "c/tsconfig.json")?.mode).toBe("incremental");
    expect(executionTreeHash(input.root)).toBe(input.identity);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
}, 120000);

test("compiler refuses wrong frozen/source identities and recreated roots cannot inherit stale state", () => {
  const input = compilerFixture();
  const copy = `${input.root}-copy`;
  try {
    expect(() => new FrozenMutationCompiler(input.root, input.contract, input.inventory, sha256("wrong"))).toThrow();
    const compiler = new FrozenMutationCompiler(input.root, input.contract, input.inventory, input.identity);
    const request = compilerRequest(input.root, input.identity, "a/value.ts", "export const value = false;");
    expect(() => compiler.check({ ...request, executionTreeSha256: sha256("wrong") })).toThrow();
    expect(() => compiler.check({ ...request, originalSha256: sha256("wrong") })).toThrow();
    expect(() => compiler.check({ ...request, sourceSha256: sha256("wrong") })).toThrow();
    for (const content of ["export const value = false;", "export const value = 1;"]) {
      cpSync(input.root, copy, { recursive: true });
      writeFileSync(join(copy, "a/value.ts"), content);
      const inventory = buildInventory(copy, input.contract);
      const fresh = new FrozenMutationCompiler(copy, input.contract, inventory, executionTreeHash(copy));
      const result = fresh.check(compilerRequest(copy, executionTreeHash(copy), "a/value.ts", content));
      expect(result.diagnostics).toEqual(diagnostics(programs(copy, input.contract, inventory)));
      rmSync(copy, { recursive: true, force: true });
    }
  } finally { rmSync(input.root, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); }
}, 120000);

test("compiler worker returns actual compiler proof and fails closed on initialization error and disposal", async () => {
  const input = compilerFixture();
  const worker = new MutationCompilerWorker(input.root, input.contract, input.inventory, input.identity, 120000);
  try {
    const request = compilerRequest(input.root, input.identity, "c/independent.ts", "export const independent = false;");
    const result = await worker.check(request);
    expect(result.kind).toBe("persistent-compiler");
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result).not.toHaveProperty("exitCode");
    expect(result).not.toHaveProperty("argv");
    await worker.close();
    expect(worker.closed).toBe(true);
    await expect(worker.check(request)).rejects.toThrow();
    const failed = new MutationCompilerWorker(input.root, input.contract, input.inventory, sha256("wrong"), 120000);
    try {
      await expect(failed.check(request)).rejects.toThrow();
      expect(failed.closed).toBe(true);
    } finally { await failed.close(); }
  } finally { await worker.close(); rmSync(input.root, { recursive: true, force: true }); }
}, 120000);

test("real mutation contract has no baseline compiler diagnostics", () => {
  const root = resolve(import.meta.dir, "..");
  const contract = readContract(resolve(root, "script/conformance/quality-contract.json"));
  expect(diagnostics(programs(root, contract, buildInventory(root, contract)))).toEqual([]);
}, 300_000);
