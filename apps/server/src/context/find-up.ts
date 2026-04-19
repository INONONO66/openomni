import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_DEPTH = 10;

export function findUp(filename: string, startDir: string): string | undefined {
  let currentDir = resolve(startDir);
  let depth = 0;

  while (depth < MAX_DEPTH) {
    const candidatePath = resolve(currentDir, filename);

    try {
      const realPath = realpathSync(candidatePath);
      if (existsSync(realPath)) {
        return realPath;
      }
    } catch {
      // realpathSync throws if path doesn't exist; continue searching
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }

    currentDir = parentDir;
    depth++;
  }

  return undefined;
}
