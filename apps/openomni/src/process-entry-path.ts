import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolves the process-transport worker entry relative to the running
 * module. Probe order is the three real layouts: bundled sibling (npm
 * package), compiled tsc output, TypeScript source (bun from src/).
 */
export function processEntryPath(baseUrl: string): string {
  const candidates = ["./process-entry.js", "./delegation/process-entry.js"];
  for (const candidate of candidates) {
    const resolved = fileURLToPath(new URL(candidate, baseUrl));
    if (existsSync(resolved)) return resolved;
  }
  return fileURLToPath(new URL("./delegation/process-entry.ts", baseUrl));
}
