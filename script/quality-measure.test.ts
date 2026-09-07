import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureMain } from "./quality-measure";

test("measurement admission rejects missing evidence before creating output", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-measure-admission-"));
  try {
    for (const omitted of ["baseline", "plan", "run", "coverage-directory"]) {
      const args = ["--root", root];
      for (const key of ["baseline", "plan", "run", "coverage-directory"]) {
        if (key !== omitted) args.push(`--${key}`, "absent");
      }
      await expect(measureMain(args)).rejects.toThrow();
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "quality-measure.ts"), ...args],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr.length).toBeGreaterThan(0);
      expect(await Bun.file(join(root, "quality-results/current.json")).exists()).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
