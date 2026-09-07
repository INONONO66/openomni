import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { makeFixture } from "./fixture";
import { decode, object, sha } from "./input";

export function invokeFixture(fixture: ReturnType<typeof makeFixture>) {
  return Bun.spawnSync([
    process.execPath, Bun.env.D945_METRICS_CLI ?? join(import.meta.dir, "../check-quality-metrics.ts"),
    "--root", fixture.root, "--inventory", fixture.inventoryPath, "--coverage", fixture.coveragePath,
  ], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
}

/** Shared deterministic execution oracle for type-erasure pairs. Both original
 * execution and independently instrumented effects are retained in receipts. */
export function observeFixture(source: string, effect: string, name: string, receipts: string[]) {
  const fixture = makeFixture([{ path: "boundary.ts", text: source }]);
  try {
    const original = Bun.spawnSync([process.execPath, join(fixture.root, "boundary.ts")], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    const emitted = ts.transpileModule(source, { fileName: "boundary.ts", compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true,
    } }).outputText;
    const child = invokeFixture(fixture);
    const stdout = child.stdout.toString(), stderr = child.stderr.toString();
    receipts.push(JSON.stringify({
      name, runtime: Bun.version, source, sourceHash: sha(source), emitted, emittedHash: sha(emitted),
      original: { pid: original.pid, exit: original.exitCode, stdout: original.stdout.toString(), stderr: original.stderr.toString() },
      effects: fixture.effects, coverage: fixture.receipt, processes: fixture.processEvidence,
      cliPid: child.pid, exit: child.exitCode, stdout, stderr,
    }));
    expect(original.exitCode).toBe(0);
    expect(original.stdout.toString()).toBe(effect);
    expect(original.stderr.toString()).toBe("");
    expect(fixture.effects).toEqual([effect]);
    expect(stderr).toBe("");
    return { result: object(decode(stdout)), emitted, exit: child.exitCode };
  } finally {
    fixture.cleanup();
    const cleanup = !existsSync(fixture.root);
    receipts.push(JSON.stringify({ name, root: fixture.root, cleanup }));
    expect(cleanup).toBe(true);
  }
}
