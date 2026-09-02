import { afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "../../src/launcher";
import { PYTHON_DRIVER } from "../../src/kernel";

/** Test-only launcher for kernel protocol tests that do not claim OS isolation. */
export const plainLauncher = () => spawn("python3", ["-u", "-c", PYTHON_DRIVER]);

const workspaceRoot = mkdtempSync(join(tmpdir(), "openomni-sandbox-tests-"));

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** Real bubblewrap profile used by Linux integration tests and probed by every daemon. */
export function testProfile(): SandboxProfile {
  return {
    backend: "bubblewrap",
    bwrapPath: "/usr/bin/bwrap",
    pythonPath: "/usr/bin/python3",
    workspaceRoot,
    readOnlyPaths: ["/usr", "/lib", "/lib64", "/bin", "/etc/ld.so.cache", "/etc/alternatives"],
    maxOutputBytes: 1_048_576,
  };
}
