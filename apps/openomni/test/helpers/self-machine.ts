import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenOmniConfig } from "../../src/config";
import { socketPath } from "./socket-path";

/**
 * A minimal valid self machine for boot fixtures (#1271): one canonical
 * tmp-dir export and the full filesystem/shell capability set.
 */
export function testSelfMachine(
  root: string = mkdtempSync(join(tmpdir(), "om-self-")),
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
