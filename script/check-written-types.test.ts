import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const checker = join(import.meta.dir, "check-written-types.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(path: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), "written-types-"));
  roots.push(root);
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return root;
}

function run(root: string) {
  const result = Bun.spawnSync([process.execPath, checker, "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("rejects written type keywords in production source", () => {
  const root = fixture(
    "packages/ipc/src/fixture.ts",
    "type Value = any;\nconst input: unknown = 1;\nconst output = input as any;\n",
  );

  const result = run(root);

  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "VIOLATION [written-types] packages/ipc/src/fixture.ts:1 any\n" +
      "VIOLATION [written-types] packages/ipc/src/fixture.ts:2 unknown\n" +
      "VIOLATION [written-types] packages/ipc/src/fixture.ts:3 any\n",
  });
});

test("accepts keyword words outside type syntax and ignores tests", () => {
  const root = fixture(
    "apps/desktop/src/fixture.tsx",
    'const text = "any unknown"; // any unknown\nconst value: string = text;\n',
  );
  writeFileSync(join(root, "apps/desktop/src/fixture.test.ts"), "type Test = any;\n");

  const result = run(root);

  expect(result).toEqual({
    code: 0,
    stdout: "OK: written any/unknown types: 0\n",
    stderr: "",
  });
});
