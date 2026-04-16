import { expect } from "bun:test";
import type { Subprocess } from "bun";

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
