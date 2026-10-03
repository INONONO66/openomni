import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenOmniConfig } from "../../src/config";
import { socketPath } from "./socket-path";

/** Default export roots created by this helper; removed after the importing file's run (r1 L4). */
const createdRoots: string[] = [];
afterAll(() => {
  for (const root of createdRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function defaultRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "om-self-"));
  createdRoots.push(root);
  return root;
}

/**
 * A minimal valid self machine for boot fixtures (#1271): one canonical
 * tmp-dir export and the full filesystem/shell capability set.
 */
export function testSelfMachine(
  root: string = defaultRoot(),
): NonNullable<OpenOmniConfig["machines"]>["self"] {
  return {
    capabilities: ["fs.read", "fs.write", "shell.exec"],
    exports: [{ name: "workspace", path: realpathSync(root) }],
  };
}

/** A full boot-ready machine plane (#1271): self on a fresh unix socket, nothing enrolled. */
export function testMachinesPlane(): NonNullable<OpenOmniConfig["machines"]> {
  return { self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] };
}
