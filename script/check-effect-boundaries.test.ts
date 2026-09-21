import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];
const checker = join(import.meta.dir, "check-effect-boundaries.ts");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(path: string, source: string, allowlist: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "effect-boundaries-"));
  roots.push(root);
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  const allowlistFile = join(root, "script/conformance/effect-runner-sites.json");
  mkdirSync(dirname(allowlistFile), { recursive: true });
  writeFileSync(allowlistFile, `${JSON.stringify(allowlist, null, 2)}\n`);
  const initialized = Bun.spawnSync(["git", "init", "--quiet"], { cwd: root, stderr: "pipe" });
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
  const added = Bun.spawnSync(["git", "add", "."], { cwd: root, stderr: "pipe" });
  if (added.exitCode !== 0) throw new Error(added.stderr.toString());
  return root;
}

function run(root: string, args: readonly string[] = []) {
  const result = Bun.spawnSync([process.execPath, checker, "--root", root, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  return { code: result.exitCode, output: result.stdout.toString(), error: result.stderr.toString() };
}

test("rejects an Effect import in protocol", () => {
  const result = run(fixture("packages/protocol/src/value.ts", 'import { Effect } from "effect";'));
  expect(result).toEqual({ code: 1, output: "packages/protocol/src/value.ts:1 R1 effect import\n", error: "" });
});

test("rejects an Effect namespace import in ui", () => {
  const result = run(fixture("packages/ui/src/value.ts", 'import * as E from "effect";'));
  expect(result).toEqual({ code: 1, output: "packages/ui/src/value.ts:1 R1 effect import\n", error: "" });
});

test("rejects an Effect re-export in desktop", () => {
  const result = run(fixture("apps/desktop/src/value.ts", 'export { Effect } from "effect";'));
  expect(result).toEqual({ code: 1, output: "apps/desktop/src/value.ts:1 R1 effect import\n", error: "" });
});

test("rejects a Promise twin beside an Effect return", () => {
  const result = run(
    fixture(
      "packages/ledger/src/commit.ts",
      ['import * as Effect from "effect";', "export function commit(): Effect.Effect<void> { return Effect.void; }", "export function commitPromise(): Promise<void> { return Promise.resolve(); }"].join("\n"),
    ),
  );
  expect(result).toEqual({ code: 1, output: "packages/ledger/src/commit.ts:3 R2 Promise twin\n", error: "" });
});

test("rejects Effect.runPromise in a runtime package", () => {
  const result = run(
    fixture("packages/agent/src/run.ts", ['import * as Effect from "effect";', "Effect.runPromise(Effect.void);"].join("\n")),
  );
  expect(result).toEqual({ code: 1, output: "packages/agent/src/run.ts:2 R2 Effect runner\n", error: "" });
});

test("rejects a directly imported aliased runner", () => {
  const result = run(
    fixture("packages/ipc/src/run.ts", ['import { runSync as execute } from "effect/Effect";', "execute({});"].join("\n")),
  );
  expect(result).toEqual({ code: 1, output: "packages/ipc/src/run.ts:1 R2 Effect runner\n", error: "" });
});

test("rejects a static runner through an Effect alias", () => {
  const result = run(
    fixture("packages/machines/src/run.ts", ['import { Effect as E } from "effect";', "E.runFork(E.void);"].join("\n")),
  );
  expect(result).toEqual({ code: 1, output: "packages/machines/src/run.ts:2 R2 Effect runner\n", error: "" });
});

test("permits an allowlisted runner in a runtime export", () => {
  const result = run(
    fixture(
      "packages/agent/src/run.ts",
      ['import * as Effect from "effect";', "export function run() { Effect.runPromise(Effect.void); }"].join("\n"),
      ["packages/agent/src/run.ts:run"],
    ),
  );
  expect(result).toEqual({ code: 0, output: "", error: "" });
});

test("rejects a stale runner allowlist entry", () => {
  const result = run(
    fixture("packages/agent/src/run.ts", "export function run() {}", ["packages/agent/src/run.ts:run"]),
  );
  expect(result).toEqual({ code: 1, output: "packages/agent/src/run.ts:1 R2 stale Effect runner allowlist\n", error: "" });
});

test("updates the runner allowlist from current runtime sites", () => {
  const root = fixture(
    "packages/agent/src/run.ts",
    ['import * as Effect from "effect";', "export function run() { Effect.runPromise(Effect.void); }"].join("\n"),
  );
  const result = run(root, ["--update"]);
  expect(result).toEqual({
    code: 0,
    output: 'wrote script/conformance/effect-runner-sites.json\n[\n  "packages/agent/src/run.ts:run"\n]\n',
    error: "",
  });
  expect(readFileSync(join(root, "script/conformance/effect-runner-sites.json"), "utf8")).toBe('[\n  "packages/agent/src/run.ts:run"\n]\n');
});

test("permits an Effect runner at the app edge", () => {
  const result = run(
    fixture("apps/openomni/src/runtime.ts", ['import * as Effect from "effect";', "Effect.runPromise(Effect.void);"].join("\n")),
  );
  expect(result).toEqual({ code: 0, output: "", error: "" });
});

test("permits a clean runtime module", () => {
  const result = run(
    fixture("packages/channels/src/delivery.ts", ['import * as Effect from "effect";', "export function deliver(): Effect.Effect<void> { return Effect.void; }"].join("\n")),
  );
  expect(result).toEqual({ code: 0, output: "", error: "" });
});
