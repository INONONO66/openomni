import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkEffectBoundaryFindings, type BoundaryFinding } from "./check-effect-boundaries";

const roots: string[] = [];
const checker = join(import.meta.dir, "check-effect-boundaries.ts");

type FixtureFile = {
  readonly path: string;
  readonly source: string;
  readonly tracked?: boolean;
};

type RunResult = {
  readonly code: number;
  readonly output: string;
  readonly error: string;
};

afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: readonly FixtureFile[], allowlist: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "effect-boundaries-"));
  roots.push(root);
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.source);
  }
  const allowlistFile = join(root, "script/conformance/effect-runner-sites.json");
  mkdirSync(dirname(allowlistFile), { recursive: true });
  writeFileSync(allowlistFile, `${JSON.stringify(allowlist, null, 2)}\n`);
  const initialized = Bun.spawnSync(["git", "init", "--quiet"], { cwd: root, stderr: "pipe" });
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
  const tracked = files.filter((file: FixtureFile): boolean => file.tracked !== false).map((file: FixtureFile): string => file.path);
  const added = Bun.spawnSync(["git", "add", "-f", "script/conformance/effect-runner-sites.json", ...tracked], { cwd: root, stderr: "pipe" });
  if (added.exitCode !== 0) throw new Error(added.stderr.toString());
  return root;
}

function run(root: string, args: readonly string[] = []): RunResult {
  const result = Bun.spawnSync([process.execPath, checker, "--root", root, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  return { code: result.exitCode, output: result.stdout.toString(), error: result.stderr.toString() };
}

function findings(root: string): readonly BoundaryFinding[] {
  return checkEffectBoundaryFindings(root);
}

function codes(root: string): readonly string[] {
  return findings(root).map((finding: BoundaryFinding): string => finding.code);
}

test("rejects namespace and direct runner calls", (): void => {
  const root = fixture([
    { path: "packages/agent/src/namespace.ts", source: 'import * as Effect from "effect"; Effect.runPromise(Effect.void);' },
    { path: "packages/ipc/src/direct.ts", source: 'import { runSync as execute } from "effect/Effect"; execute({});' },
  ]);
  expect(codes(root)).toEqual(expect.arrayContaining(["R2_EFFECT_RUNNER"]));
  expect(run(root).code).toBe(1);
});

test("rejects a runner passed as a value and in pipe", (): void => {
  const root = fixture([
    { path: "packages/agent/src/value.ts", source: ['import * as Effect from "effect";', "const callback = Effect.runPromise; Effect.void.pipe(Effect.runPromise); callback(Effect.void);"].join("\n") },
  ]);
  expect(codes(root)).toContain("R2_EFFECT_RUNNER");
  expect(run(root).code).toBe(1);
});

test("follows a runner through a repository re-export", (): void => {
  const root = fixture([
    { path: "packages/agent/src/reexport.ts", source: 'export { runPromise as rp } from "effect/Effect";' },
    { path: "packages/agent/src/use.ts", source: ['import { rp } from "./reexport";', "rp({});"].join("\n") },
  ]);
  expect(findings(root)).toContainEqual({ file: "packages/agent/src/use.ts", line: 2, code: "R2_EFFECT_RUNNER", failing: true });
  expect(run(root).code).toBe(1);
});

test("rejects ManagedRuntime.make in a package", (): void => {
  const root = fixture([{ path: "packages/machines/src/runtime.ts", source: ['import { ManagedRuntime } from "effect";', "ManagedRuntime.make({});"].join("\n") }]);
  expect(codes(root)).toContain("R2_EFFECT_RUNNER");
  expect(run(root).code).toBe(1);
});

test("rejects an exported Promise twin", (): void => {
  const root = fixture([
    {
      path: "packages/ledger/src/commit.ts",
      source: ['import * as Effect from "effect";', "export function commit(): Effect.Effect<void> { return Effect.void; }", "export function commitPromise(): Promise<void> { return Promise.resolve(); }"].join("\n"),
    },
  ]);
  expect(codes(root)).toContain("R3_PROMISE_TWIN");
  expect(run(root).code).toBe(1);
});

test("rejects an Effect import in protocol and a forbidden dependency", (): void => {
  const root = fixture([
    { path: "packages/protocol/src/value.ts", source: 'import { Effect } from "effect";' },
    { path: "packages/protocol/package.json", source: JSON.stringify({ dependencies: { effect: "3.22.2" } }) },
  ]);
  expect(codes(root)).toEqual(expect.arrayContaining(["R1_EFFECT_IMPORT", "R1_EFFECT_DEPENDENCY"]));
  expect(run(root).code).toBe(1);
});

test("rejects an Effect import in a tool body", (): void => {
  const root = fixture([{ path: "apps/openomni/src/tools/send-message.ts", source: 'import { Effect } from "effect";' }]);
  expect(codes(root)).toContain("R1_TOOL_EFFECT_IMPORT");
  expect(run(root).code).toBe(1);
});

test("scans an untracked source file", (): void => {
  const root = fixture([{ path: "packages/channels/src/untracked.ts", source: 'import * as Effect from "effect"; Effect.runSync(Effect.void);', tracked: false }]);
  expect(codes(root)).toContain("R2_EFFECT_RUNNER");
  expect(run(root).code).toBe(1);
});

test("reports stale ratchet rows as failures", (): void => {
  const root = fixture([{ path: "packages/agent/src/clean.ts", source: "export const clean = 1;" }], ["packages/agent/test/missing.test.ts:7"]);
  expect(codes(root)).toContain("R2_STALE_ALLOWLIST");
  expect(run(root).code).toBe(1);
});

test("reports a live ratchet row without failing", (): void => {
  const root = fixture(
    [{ path: "packages/agent/test/run.test.ts", source: ['import * as Effect from "effect";', "Effect.runPromise(Effect.void);"].join("\n") }],
    ["packages/agent/test/run.test.ts:2"],
  );
  expect(codes(root)).toContain("R2_ALLOWLISTED_RATCHET");
  expect(run(root).code).toBe(0);
});

test("rejects a production src ratchet row so production runners always fail", (): void => {
  const root = fixture(
    [{ path: "packages/agent/src/run.ts", source: ['import * as Effect from "effect";', "Effect.runPromise(Effect.void);"].join("\n") }],
    ["packages/agent/src/run.ts:2"],
  );
  expect(codes(root)).toEqual(["R2_EFFECT_RUNNER", "R2_INVALID_ALLOWLIST"]);
  expect(run(root).code).toBe(1);
});

test("permits exactly the two app-owned edges", (): void => {
  const root = fixture([
    { path: "apps/openomni/src/cli/main.ts", source: 'import * as Effect from "effect"; Effect.runPromise(Effect.void);' },
    { path: "apps/openomni/src/gateway.ts", source: 'import { ManagedRuntime } from "effect"; ManagedRuntime.make({});' },
    { path: "apps/openomni/src/runtime.ts", source: 'import * as Effect from "effect"; Effect.runSync(Effect.void);' },
  ]);
  const result = findings(root);
  expect(result).toEqual([{ file: "apps/openomni/src/runtime.ts", line: 1, code: "R2_EFFECT_RUNNER", failing: true }]);
  expect(run(root).code).toBe(1);
});

test.each([
  "Effect.runPromise", "Effect.runSync", "Effect.runFork", "Effect.runCallback", "Effect.runPromiseExit", "Effect.runSyncExit",
  "Runtime.runPromise", "Runtime.runSync", "Runtime.runFork", "Runtime.runCallback", "Runtime.runPromiseExit", "Runtime.runSyncExit",
  "ManagedRuntime.make", "Layer.toRuntime",
])("detects %s through a root namespace alias", (runner: string): void => {
  const root = fixture([{ path: "packages/policy/src/run.ts", source: `import * as FX from "effect";\nFX.${runner}({});` }]);
  expect(findings(root)).toEqual([{ file: "packages/policy/src/run.ts", line: 2, code: "R2_EFFECT_RUNNER", failing: true }]);
});

test.each(["Runtime.runCallback", "ManagedRuntime.make", "Layer.toRuntime"])("detects a direct aliased %s import", (runner: string): void => {
  const [module, method] = runner.split(".");
  const root = fixture([{ path: "script/run.ts", source: `import { ${method} as execute } from "effect/${module}";\nexecute({});` }]);
  expect(findings(root)).toContainEqual({ file: "script/run.ts", line: 2, code: "R2_EFFECT_RUNNER", failing: true });
});

test("resolves multi-hop export stars, namespace exports and local exported aliases", (): void => {
  const root = fixture([
    { path: "script/z-origin.ts", source: 'import { runPromise as rp } from "effect/Effect"; export { rp as launch }; export { Effect as E } from "effect";' },
    { path: "script/b-barrel.ts", source: 'export * from "./z-origin.js";' },
    { path: "script/a-barrel.ts", source: 'export * as Fx from "./b-barrel";' },
    { path: "script/consumer.ts", source: 'import { Fx } from "./a-barrel";\nFx.launch({});\nFx.E.runSync({});' },
  ]);
  const result = findings(root);
  for (const line of [2, 3]) expect(result).toContainEqual({ file: "script/consumer.ts", line, code: "R2_EFFECT_RUNNER", failing: true });
});

test("follows external export stars and stops on circular barrels", (): void => {
  const root = fixture([
    { path: "script/a.ts", source: 'export * from "./b"; export * from "effect/Effect";' },
    { path: "script/b.ts", source: 'export * from "./a";' },
    { path: "script/use.ts", source: 'import { runPromise as rp } from "./b";\nrp({});' },
  ]);
  expect(findings(root)).toContainEqual({ file: "script/use.ts", line: 2, code: "R2_EFFECT_RUNNER", failing: true });
});

test("does not treat type references or unrelated same-named methods as execution", (): void => {
  const root = fixture([{ path: "script/types.ts", source: [
    'import { Effect } from "effect";',
    'import type { runPromise } from "effect/Effect";',
    'import { type runSync } from "effect/Effect";',
    "export type R = typeof Effect.runPromise;",
    "const unrelated = { runPromise: () => 1 }; unrelated.runPromise();",
  ].join("\n") }]);
  expect(findings(root)).toEqual([]);
});

test("rejects dynamic, require and type-only effect imports on excluded surfaces", (): void => {
  const root = fixture([{ path: "packages/protocol/src/import.ts", source: [
    'const dynamic = import("effect");',
    'const required = require("effect/Effect");',
    'type Native = import("effect/Effect").Effect<void>;',
  ].join("\n") }]);
  expect(findings(root).map((entry: BoundaryFinding): number => entry.line)).toEqual([1, 2, 3]);
});

test("resolves a local constant alias without flagging a shadowed parameter", (): void => {
  const root = fixture([{ path: "script/alias.ts", source: [
    'import { Effect as E } from "effect";',
    "const launch = E.runPromise;",
    "launch({});",
    "function shadow(E: { runPromise: () => void }) { E.runPromise(); }",
  ].join("\n") }]);
  expect(findings(root)).toEqual([
    { file: "script/alias.ts", line: 2, code: "R2_EFFECT_RUNNER", failing: true },
    { file: "script/alias.ts", line: 3, code: "R2_EFFECT_RUNNER", failing: true },
  ]);
});

test("allows both approved edges on their own", (): void => {
  const root = fixture([
    { path: "apps/openomni/src/cli/main.ts", source: 'import { Effect } from "effect"; Effect.runSync(Effect.void);' },
    { path: "apps/openomni/src/gateway.ts", source: 'import { ManagedRuntime } from "effect"; ManagedRuntime.make({});' },
  ]);
  expect(findings(root)).toEqual([]);
  expect(run(root).code).toBe(0);
});

test.each(["packages/ui/src/view.tsx", "apps/desktop/src/main.ts", "apps/openomni/src/tools/core/filesystem.ts"])("excludes imports in %s", (path: string): void => {
  const root = fixture([{ path, source: 'import type { Effect } from "effect/Effect";' }]);
  expect(codes(root)).toEqual([path.includes("/tools/") ? "R1_TOOL_EFFECT_IMPORT" : "R1_EFFECT_IMPORT"]);
});

test.each(["packages/protocol/package.json", "packages/ui/package.json", "apps/desktop/package.json"])("excludes effect dependencies in %s", (path: string): void => {
  const root = fixture([{ path, source: JSON.stringify({ peerDependencies: { effect: "3.22.2" } }) }]);
  expect(codes(root)).toEqual(["R1_EFFECT_DEPENDENCY"]);
});

test("finds inferred suffix twins, matching return values and exported runPromise wrappers", (): void => {
  const root = fixture([{ path: "packages/codemode/src/run.ts", source: [
    'import { Effect as E } from "effect";',
    "const perform = () => E.succeed(1);",
    "export { perform };",
    "export const performAsync = async () => 1;",
    "export const native = (): E.Effect<number> => E.succeed(1);",
    "export function separate(): Promise<number> { return Promise.resolve(1); }",
    "export const wrapper = () => E.runPromise(perform());",
  ].join("\n") }]);
  const result = findings(root).filter((entry: BoundaryFinding): boolean => entry.code === "R3_PROMISE_TWIN");
  expect(result.map((entry: BoundaryFinding): number => entry.line)).toEqual([4, 6, 7]);
});

test("scans test, script and untracked TSX surfaces but ignores generated and ignored files", (): void => {
  const runner = 'import { Effect } from "effect"; Effect.runSync({});';
  const root = fixture([
    { path: ".gitignore", source: "ignored.ts\n" },
    { path: "script/ignored.ts", source: runner, tracked: false },
    { path: "packages/agent/dist/generated.ts", source: runner },
    { path: "apps/openomni/node_modules/dependency/index.ts", source: runner },
    { path: "packages/agent/test/run.test.ts", source: runner },
    { path: "apps/openomni/src/view.tsx", source: runner, tracked: false },
    { path: "script/literals.ts", source: `export const fixtureSource = ${JSON.stringify(runner)};` },
  ]);
  expect(findings(root).map((entry: BoundaryFinding): string => entry.file)).toEqual([
    "apps/openomni/src/view.tsx", "packages/agent/test/run.test.ts",
  ]);
});

test("rejects malformed, duplicate, missing and stale function ratchet rows", (): void => {
  const root = fixture([{ path: "packages/agent/test/run.test.ts", source: "export function run() {}" }], ["packages/agent/test/run.test.ts:run"]);
  expect(codes(root)).toEqual(["R2_STALE_ALLOWLIST"]);
  const path = join(root, "script/conformance/effect-runner-sites.json");
  for (const invalid of ["{", "{}", "[1]", '["bad"]', '["packages/agent/test/run.test.ts:run","packages/agent/test/run.test.ts:run"]', '["script/run.ts:run"]']) {
    writeFileSync(path, invalid);
    expect(codes(root)).toEqual(["R2_INVALID_ALLOWLIST"]);
  }
  rmSync(path);
  expect(codes(root)).toEqual(["R2_MISSING_ALLOWLIST"]);
});

test("rejects runtime allowance and update flags without changing the ratchet", (): void => {
  const root = fixture([]);
  const path = join(root, "script/conformance/effect-runner-sites.json");
  const before = readFileSync(path, "utf8");
  for (const flag of ["--update", "--allow-runtime", "--allow-runners"]) {
    const result = run(root, [flag]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('"code":"INVALID_ARGUMENTS"');
  }
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("fails closed on invalid source and invalid manifests", (): void => {
  const root = fixture([{ path: "script/broken.ts", source: "export const broken = ;" }]);
  expect(codes(root)).toEqual(["ANALYSIS_ERROR"]);
  expect(run(root).code).toBe(1);
  const manifestRoot = fixture([{ path: "packages/ui/package.json", source: "{" }]);
  const result = run(manifestRoot);
  expect(result.code).toBe(1);
  expect(result.output).toContain('"code":"ANALYSIS_ERROR"');
});

test("permits a clean runtime module", (): void => {
  const root = fixture([{ path: "packages/channels/src/delivery.ts", source: ['import * as Effect from "effect";', "export function deliver(): Effect.Effect<void> { return Effect.void; }"] .join("\n") }]);
  expect(findings(root)).toEqual([]);
  expect(run(root).code).toBe(0);
});
