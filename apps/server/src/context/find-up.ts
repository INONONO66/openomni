import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_DEPTH = 10;

const cache = new Map<string, string | undefined>();

export function findUp(filename: string, startDir: string): string | undefined {
  const key = `${filename}\0${resolve(startDir)}`;
  if (cache.has(key)) return cache.get(key);

  let currentDir = resolve(startDir);
  let depth = 0;

  while (depth < MAX_DEPTH) {
    const candidatePath = resolve(currentDir, filename);

    try {
      const realPath = realpathSync(candidatePath);
      if (existsSync(realPath)) {
        cache.set(key, realPath);
        return realPath;
      }
    } catch {
      // realpathSync throws if path doesn't exist; continue searching
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
    depth++;
  }

  cache.set(key, undefined);
  return undefined;
}
