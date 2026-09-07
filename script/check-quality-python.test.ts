import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "check-quality-python.ts");

test("Python gate rejects warning-only and error diagnostics through the real checker", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-python-"));
  try {
    for (const [name, source, expected] of [
      ["clean", "def identity(value: int) -> int:\n    return value\n", 0],
      ["warning", "def identity(value):\n    return value\n", 1],
      ["error", 'value: int = "wrong"\n', 1],
    ] as const) {
      const path = join(root, `${name}.py`);
      writeFileSync(path, source);
      const child = Bun.spawnSync([process.execPath, cli, "--file", path], { timeout: 60_000 });
      expect(child.exitCode).toBe(expected);
    }
    const rejected = Bun.spawnSync([process.execPath, cli, "--update"], { timeout: 5000 });
    expect(rejected.exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
