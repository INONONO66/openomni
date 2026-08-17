import { expect } from "bun:test";
import type { Subprocess } from "bun";

/** Live direct children of this process — the real before/after census. */
export function listChildPids(): number[] {
  const result = Bun.spawnSync(["pgrep", "-P", String(process.pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // pgrep exits 1 when nothing matches; that is a legitimate empty census.
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== result.pid);
}

export function assertNoOrphanProcesses(beforePids: number[], afterPids: number[]): void {
  const leaked = afterPids.filter((pid) => !beforePids.includes(pid));
  expect(leaked).toEqual([]);
}

export async function assertCleanExit(proc: Subprocess, timeoutMs = 5000): Promise<void> {
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  expect(exitCode).toBe(0);
}
