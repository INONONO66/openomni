import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { buildInventory, readContract } from "./quality-inventory";
import { programs, diagnostics, executionTreeHash, main, pythonExecutable, sha256 } from "./run-quality-mutations";
import { COMPILER_BATCH_SIZE, FrozenMutationCompiler, MutationCompilerWorker, serveCompiler } from "./quality-mutation-compiler";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

test("typecheck CLI reports native valid and invalid source outcomes in process", async () => {
  const input = compilerFixture();
  try {
    const contract = join(input.root, "contract.json"), inventory = join(input.root, "inventory.json");
    writeFileSync(contract, JSON.stringify(input.contract));
    writeFileSync(inventory, JSON.stringify(input.inventory));
    const args = ["--typecheck-root", input.root, "--contract", contract, "--inventory", inventory];
    expect(await main(args)).toBe(0);
    writeFileSync(join(input.root, "a/value.ts"), 'export const value = "wrong";');
    expect(await main(args)).toBe(1);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
}, 120000);

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

test("batched compiler checks preserve cold diagnostics and reuse affected projects", () => {
  const input = compilerFixture();
  try {
    const compiler = new FrozenMutationCompiler(input.root, input.contract, input.inventory, input.identity);
    const sources = ["export const value = 2;", 'export const value = "wrong";', "export const value = false;", input.files["a/value.ts"]];
    const requests = sources.map((source) => compilerRequest(input.root, input.identity, "a/value.ts", source));
    const results = compiler.checkBatch(requests);
    expect(results).toHaveLength(requests.length);
    expect(() => compiler.checkBatch([])).toThrow("Invalid compiler batch size");
    expect(() => compiler.checkBatch(Array.from({ length: COMPILER_BATCH_SIZE + 1 },
      () => compilerRequest(input.root, input.identity, "a/value.ts", input.files["a/value.ts"])))).toThrow("Invalid compiler batch size");
    for (const [index, result] of results.entries()) {
      const request = requests[index];
      if (!request) throw new Error("Missing batch request");
      writeFileSync(join(input.root, request.path), request.content);
      let cold: string[];
      try { cold = diagnostics(programs(input.root, input.contract, input.inventory)); }
      finally { writeFileSync(join(input.root, request.path), input.files["a/value.ts"]); }
      expect(result.diagnostics).toEqual(cold);
      expect(result.valid).toBe(cold.length === 0);
      expect(result.candidateId).toBe(request.candidateId);
      expect(result.sourceSha256).toBe(request.sourceSha256);
      expect(result.projects.filter((project) => project.mode !== "frozen").map((project) => [project.project, project.mode])).toEqual([
        ["a/tsconfig.json", index === 0 ? "cold" : "incremental"],
        ["b/tsconfig.json", index === 0 ? "cold" : "incremental"],
        ["inventory-fallback", index === 0 ? "cold" : "incremental"],
      ]);
    }
    expect(executionTreeHash(input.root)).toBe(input.identity);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
}, 120000);

test("compiler overlays workspace package consumers through an aliased execution root", () => {
  const input = compilerFixture();
  const alias = `${input.root}-alias`;
  try {
    mkdirSync(join(input.root, "b/node_modules/@fixture"), { recursive: true });
    writeFileSync(join(input.root, "a/package.json"), JSON.stringify({ name: "@fixture/value", exports: "./value.ts" }));
    symlinkSync("../../../a", join(input.root, "b/node_modules/@fixture/value"));
    writeFileSync(join(input.root, "b/consumer.ts"), 'import { value } from "@fixture/value"; export const result: number = value;');
    symlinkSync(input.root, alias);
    const inventory = buildInventory(alias, input.contract);
    const identity = executionTreeHash(alias);
    const compiler = new FrozenMutationCompiler(alias, input.contract, inventory, identity);
    const requests = ['export const value = "wrong";', input.files["a/value.ts"]]
      .map((content) => compilerRequest(alias, identity, "a/value.ts", content));
    const results = compiler.checkBatch(requests);
    for (const [index, result] of results.entries()) {
      const request = requests[index];
      if (!request) throw new Error("Missing aliased compiler request");
      writeFileSync(join(alias, request.path), request.content);
      try { expect(result.diagnostics).toEqual(diagnostics(programs(alias, input.contract, inventory))); }
      finally { writeFileSync(join(alias, request.path), input.files["a/value.ts"]); }
      expect(result.valid).toBe(index === 1);
      expect(result.projects.find((project) => project.project === "b/tsconfig.json")?.mode)
        .toBe(index === 0 ? "cold" : "incremental");
    }
    expect(executionTreeHash(alias)).toBe(identity);
  } finally {
    rmSync(alias, { force: true });
    rmSync(input.root, { recursive: true, force: true });
  }
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

test("compiler worker closes after an unexpected child exit and preserves its receipt", async () => {
  const input = compilerFixture();
  let child: import("node:child_process").ChildProcessWithoutNullStreams | undefined;
  const exited = Promise.withResolvers<[number | null, NodeJS.Signals | null]>();
  const worker = new MutationCompilerWorker(
    input.root,
    input.contract,
    input.inventory,
    input.identity,
    120000,
    (spawned) => {
      child = spawned;
      spawned.once("exit", (code, signal) => exited.resolve([code, signal]));
    },
  );
  try {
    await worker.check(compilerRequest(input.root, input.identity, "c/independent.ts", "export const independent = false;"));
    if (child === undefined) throw new Error("compiler child was not captured");
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await bounded(exited.promise)).toEqual([null, "SIGKILL"]);
    await bounded(worker.close());
    expect(worker.processReceipt).toMatchObject({
      pid: expect.any(Number),
      exitCode: null,
      signal: "SIGKILL",
      cleanupExit: 1,
      stderr: expect.any(String),
    });
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    try {
      await bounded(worker.close());
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  }
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
    expect(worker.processReceipt).toMatchObject({
      pid: expect.any(Number), exitCode: null, signal: "SIGKILL", cleanupExit: 0,
    });
    expect(worker.processReceipt?.stderr).toContain("compiler project");
    await expect(worker.check(request)).rejects.toThrow();
    const failed = new MutationCompilerWorker(input.root, input.contract, input.inventory, sha256("wrong"), 120000);
    try {
      await expect(failed.check(request)).rejects.toThrow();
      expect(failed.closed).toBe(true);
    } finally { await failed.close(); }
  } finally { await worker.close(); rmSync(input.root, { recursive: true, force: true }); }
}, 120000);

test("compiler message server returns initialization errors and real diagnostics over message ports", async () => {
  const input = compilerFixture();
  const { port1, port2 } = new MessageChannel();
  serveCompiler(port2);
  const next = () => new Promise<Parameters<Parameters<typeof serveCompiler>[0]["postMessage"]>[0]>((resolveResponse) => port1.once("message", resolveResponse));
  try {
    const request = compilerRequest(input.root, input.identity, "c/independent.ts", "export const independent: number = false;");
    let response = next();
    port1.postMessage({ kind: "check", requests: [request] });
    expect(await response).toEqual({ kind: "error", message: "Compiler worker not initialized" });
    response = next();
    port1.postMessage({ kind: "initialize", ...input, identity: sha256("wrong") });
    expect(await response).toEqual({ kind: "error", message: "Compiler frozen execution identity mismatch" });
    response = next();
    port1.postMessage({ kind: "initialize", ...input });
    expect(await response).toEqual({ kind: "ready" });
    response = next();
    port1.postMessage({ kind: "check", requests: [request] });
    const checked = await response;
    if (checked.kind !== "checked") throw new Error("Missing compiler result");
    expect(checked.proofs).toHaveLength(1);
    const result = checked.proofs[0];
    if (!result) throw new Error("Missing compiler proof");
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((error) => error.includes("not assignable"))).toBe(true);
    expect(result.candidateId).toBe(request.candidateId);
  } finally {
    port1.close();
    port2.close();
    rmSync(input.root, { recursive: true, force: true });
  }
}, 120000);

test("inventory fallback resolves ambient types from its root rather than the process cwd", () => {
  const input = compilerFixture();
  const cwd = process.cwd();
  try {
    const declarations = join(input.root, "node_modules/@types/campaign");
    mkdirSync(declarations, { recursive: true });
    writeFileSync(join(declarations, "index.d.ts"), "declare const campaignValue: number;");
    writeFileSync(join(input.root, "fallback.ts"), "export const fallback = campaignValue;");
    const inventory = buildInventory(input.root, input.contract);
    process.chdir(tmpdir());
    expect(diagnostics(programs(input.root, input.contract, inventory))).toEqual([]);
    const compiler = new FrozenMutationCompiler(input.root, input.contract, inventory, executionTreeHash(input.root));
    const checked = compiler.check(compilerRequest(input.root, compiler.identity, "fallback.ts", "export const fallback: string = campaignValue;"));
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics.some((value) => value.includes("Cannot find name"))).toBe(false);
  } finally { process.chdir(cwd); rmSync(input.root, { recursive: true, force: true }); }
}, 120000);

test("compiler fallback stays inside the frozen root and Python command names resolve", () => {
  const input = compilerFixture();
  const outside = mkdtempSync(join(tmpdir(), "mutation-outside-"));
  try {
    const config = join(outside, "tsconfig.json");
    writeFileSync(config, "{}");
    const inventory = {
      ...input.inventory,
      configurations: [
        ...input.inventory.configurations,
        { path: relative(input.root, config), sha256: sha256(readFileSync(config)) },
      ],
    };
    expect(() => new FrozenMutationCompiler(input.root, input.contract, inventory, input.identity)).toThrow(
      "Unsafe relative path",
    );
    expect(pythonExecutable("python3")).toBe(Bun.which("python3") ?? "python3");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("real mutation contract has no baseline compiler diagnostics", () => {
  const root = resolve(import.meta.dir, "..");
  const contract = readContract(resolve(root, "script/conformance/quality-contract.json"));
  expect(diagnostics(programs(root, contract, buildInventory(root, contract)))).toEqual([]);
}, 300_000);
