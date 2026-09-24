import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkBundleImports, main } from "./check-deps";
import { TOPOLOGY } from "./topology";

const roots: string[] = [];
const checker = join(import.meta.dir, "check-deps.ts");
const audit = "apps/openomni/src/bundles/audit-log/index.ts";
const demo = "apps/openomni/src/bundles/demo/index.ts";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Readonly<Record<string, string>>, directory = tmpdir()): string {
  const root = mkdtempSync(join(directory, "bundle-imports-"));
  roots.push(root);
  const manifests = Object.fromEntries(
    TOPOLOGY.map((workspace) => [
      `${workspace.dir}/package.json`,
      JSON.stringify({ name: workspace.packageName }),
    ]),
  );
  for (const [path, source] of Object.entries({ ...manifests, ...files })) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

async function runInProcess(root: string) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const output: string[] = [];
  const error: string[] = [];
  const logged = spyOn(console, "log").mockImplementation((message: string) =>
    output.push(message),
  );
  const warned = spyOn(console, "warn").mockImplementation((message: string) =>
    error.push(message),
  );
  const failed = spyOn(console, "error").mockImplementation((message: string) =>
    error.push(message),
  );
  try {
    process.chdir(root);
    await main();
    return { code: process.exitCode, output: output.join("\n"), error: error.join("\n") };
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode ?? 0;
    logged.mockRestore();
    warned.mockRestore();
    failed.mockRestore();
  }
}

async function run(root: string) {
  const inProcess = await runInProcess(root);
  const result = Bun.spawnSync([process.execPath, checker], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const error = result.stderr.toString();
  expect(inProcess.code).toBe(result.exitCode);
  expect(result.stdout.toString().trimEnd()).toBe(inProcess.output);
  expect(error.trimEnd()).toBe(inProcess.error);
  return { code: result.exitCode, error };
}

test.each([
  'import { value } from "../demo/index.js";',
  'import type { Value } from "../demo/index.js";',
  'import "../demo/index.js";',
  'export { value as renamed } from "../demo/index.js";',
  'export type { Value } from "../demo/index.js";',
  'export * from "../demo/index.js";',
  'export * as Demo from "../demo/index.js";',
  'const loaded = import("../demo/index.js");',
  "const loaded = import(`../demo/index.js`);",
  'const loaded = require("../demo/index.js");',
  'import loaded = require("../demo/index.js");',
  'type Loaded = import("../demo/index.js").Value;',
  'const load = require; const again = load; again("../demo/index.js");',
  'import { createRequire as makeRequire } from "node:module"; const load = makeRequire(import.meta.url); load("../demo/index.js");',
  'import { value } from "../demo/../demo/index.js";',
])("refuses cross-bundle imports: %s", async (source) => {
  // Given production-shaped, untracked modules using different namespaces.
  const root = fixture({
    [audit]: `// entry\n${source}`,
    [demo]: "export const value = 1; export type Value = number;",
  });
  // When the real dependency CLI scans the fixture.
  const result = await run(root);
  // Then the source edge, not a manifest or type error, refuses the import.
  expect(result.code).toBe(1);
  expect(result.error).toContain(`BUNDLE_CROSS_NAMESPACE ${audit}:2`);
});

test("refuses tsconfig aliases inherited by the app", async () => {
  const root = fixture({
    "tsconfig.base.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "#demo/*": ["apps/openomni/src/bundles/demo/*"] } },
    }),
    "apps/openomni/tsconfig.json": JSON.stringify({
      extends: "../../tsconfig.base.json",
      include: ["src"],
    }),
    [audit]: 'import { value } from "#demo/index";',
    [demo]: "export const value = 1;",
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain(`BUNDLE_CROSS_NAMESPACE ${audit}:1`);
});

test.each([
  'export * from "./bundles/demo/index.js";',
  'import { value } from "./bundles/demo/index.js"; export const indirect = value;',
  'export type Value = import("./bundles/demo/index.js").Value;',
])("refuses laundering through an app barrel: %s", async (source) => {
  const root = fixture({
    [audit]: 'import * as bridge from "../../bridge.js";',
    "apps/openomni/src/bridge.ts": 'export * from "./cycle.js";',
    "apps/openomni/src/cycle.ts": `export * from "./bridge.js";\n${source}`,
    [demo]: "export const value = 1; export type Value = number;",
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_CROSS_NAMESPACE apps/openomni/src/cycle.ts:2");
});

test.each([
  "import(destination);",
  `import(\`../\${namespace}/index.js\`);`,
  'require("../" + namespace + "/index.js");',
  "const load = require; load(destination);",
])("refuses computed paths reachable by a bundle: %s", async (source) => {
  const root = fixture({
    [audit]: 'import "../../bridge.js";',
    "apps/openomni/src/bridge.ts": source,
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_COMPUTED_IMPORT apps/openomni/src/bridge.ts:1");
});

test("allows same namespace, external dependencies, approved core barrels and app composition", async () => {
  const root = fixture({
    [audit]:
      'import "./internal.js"; import type { PlainValue } from "@openomni/protocol"; import { Layer } from "effect";',
    "apps/openomni/src/bundles/audit-log/internal.ts":
      'export * from "./index.js"; const text = \'import("../demo/index.js")\'; function local(require: (s: string) => string) { return require("../demo/index.js"); }',
    [demo]: "export const value = 1;",
    "apps/openomni/src/composition.ts":
      'import "./bundles/audit-log/index.js"; import "./bundles/demo/index.js";',
  });
  expect((await run(root)).code).toBe(0);
});

test("accepts a clean repository with no dependency or doc warnings", async () => {
  // Nested in the existing worktree so git can establish that these new docs have no history.
  // No index, commit or git configuration is changed.
  const docs = [
    "",
    "packages/protocol/",
    "packages/ipc/",
    "packages/ledger/",
    "packages/llm/",
    "packages/agent/",
    "packages/channels/",
  ];
  const root = fixture(
    Object.fromEntries(docs.map((directory) => [`${directory}AGENTS.md`, ""])),
    import.meta.dir,
  );
  const result = await run(root);
  expect(result.code).toBe(0);
  expect(result.error).toBe("");
});

test.each([
  ["import {", "BUNDLE_PARSE_ERROR"],
  ['import "./missing.js";', "BUNDLE_UNRESOLVED_IMPORT"],
  ['const loaded = require("@openomni/ui");', "BUNDLE_IMPORT_NOT_ALLOWED"],
  ['type Loaded = import("@openomni/agent/src/services").Clock;', "BUNDLE_IMPORT_NOT_ALLOWED"],
])("fails closed for %s", async (source, code) => {
  const root = fixture({ [audit]: source });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain(`${code} ${audit}:1`);
});

test.each([
  'import * as Module from "node:module"; const load = Module.createRequire(import.meta.url); load("../demo/index.js");',
  'import { load } from "../../loader.js"; load("../demo/index.js");',
  'import * as Module from "node:module"; const { createRequire: make } = Module; const load = make(import.meta.url); load("../demo/index.js");',
  'import Module from "node:module"; const load = Module["createRequire"](import.meta.url); load("../demo/index.js");',
  'import * as Module from "node:module"; const alias = Module; const load = alias.createRequire(import.meta.url); load("../demo/index.js");',
  'const load = (require as typeof require); load("../demo/index.js");',
])("refuses loader aliases crossing a barrel: %s", async (source) => {
  const root = fixture({
    [audit]: source,
    [demo]: "export const value = 1;",
    "apps/openomni/src/loader.ts": 'export { load } from "./loader-origin.js";',
    "apps/openomni/src/loader-origin.ts": "export const load = require;",
  });
  expect(await checkBundleImports(root)).toContainEqual({
    code: "BUNDLE_CROSS_NAMESPACE",
    file: audit,
    line: 1,
  });
  expect((await run(root)).code).toBe(1);
});

test.each([
  '{ "compilerOptions": { "target": "invalid" } }',
  '{ "extends": "./missing.json" }',
  '{ "compilerOptions": ',
])("refuses invalid resolution configuration: %s", async (config) => {
  const root = fixture({
    [audit]: 'import "../demo/index.js";',
    [demo]: "export {};",
    "apps/openomni/tsconfig.json": config,
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_CONFIG_ERROR apps/openomni/tsconfig.json:");
});

test("refuses a config that exists but cannot be read", async () => {
  const config = "apps/openomni/tsconfig.json";
  const root = fixture({ [audit]: "export {};", [config]: "{}" });
  chmodSync(join(root, config), 0o000);
  try {
    expect(await checkBundleImports(root)).toEqual([
      { code: "BUNDLE_CONFIG_ERROR", file: config, line: 1 },
    ]);
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.error).toContain(`BUNDLE_CONFIG_ERROR ${config}:1`);
  } finally {
    chmodSync(join(root, config), 0o600);
  }
});

test("refuses a resolved local file excluded from the compiler program", async () => {
  const root = fixture({
    [audit]: 'import "#shared";',
    "shared/api.ts": "export const value = 1;",
    "apps/openomni/tsconfig.json": JSON.stringify({
      compilerOptions: { noResolve: true, paths: { "#shared": ["../../shared/api.ts"] } },
      include: ["src"],
    }),
  });
  expect(await checkBundleImports(root)).toEqual([
    { code: "BUNDLE_UNRESOLVED_IMPORT", file: "shared/api.ts", line: 1 },
  ]);
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_UNRESOLVED_IMPORT shared/api.ts:1");
});

test("allows a repository without production bundles and ignores isolated test fixtures", async () => {
  const root = fixture({
    "apps/openomni/test/bundles/audit/index.ts": 'import "../demo/index.js";',
    "apps/openomni/src/bundles/demo/example.test.ts": 'import "../audit/index.js";',
  });
  expect(await checkBundleImports(root)).toEqual([]);
});

test("allows composition outside the reserved namespace directories", async () => {
  const root = fixture({
    "apps/openomni/src/bundles/index.ts":
      'export * from "./audit-log/index.js"; export * from "./demo/index.js";',
    [audit]: "export const audit = 1;",
    [demo]: "export const demo = 2;",
  });
  expect(await checkBundleImports(root)).toEqual([]);
});

test("follows require edges into shared barrels", async () => {
  const root = fixture({
    [audit]: 'const shared = require("../../shared.js");',
    "apps/openomni/src/shared.ts": 'export * from "./bundles/demo/index.js";',
    [demo]: "export {};",
  });
  expect(await checkBundleImports(root)).toContainEqual({
    code: "BUNDLE_CROSS_NAMESPACE",
    file: "apps/openomni/src/shared.ts",
    line: 1,
  });
});

test("refuses unresolved aliases instead of treating them as external dependencies", async () => {
  const root = fixture({
    [audit]: 'import "bundle/demo";',
    "apps/openomni/tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "bundle/*": ["./src/bundles/*"] } },
      include: ["src"],
    }),
  });
  expect(await checkBundleImports(root)).toEqual([
    { code: "BUNDLE_UNRESOLVED_IMPORT", file: audit, line: 1 },
  ]);
});
