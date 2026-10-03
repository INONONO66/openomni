import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenOmniConfig } from "../../src/config";

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
