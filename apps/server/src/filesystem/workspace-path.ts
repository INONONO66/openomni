import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";

export function resolveContainedPath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, inputPath);
  assertInsideRoot(resolved, root);

  try {
    assertRealpathContained(resolved, root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    assertRealpathContained(dirname(resolved), root);
  }

  return resolved;
}

export function resolveContainedPathForCreate(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, inputPath);
  assertInsideRoot(resolved, root);

  try {
    assertRealpathContained(resolved, root);
    return resolved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let parent = dirname(resolved);
  while (parent !== root) {
    try {
      assertRealpathContained(parent, root);
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const nextParent = dirname(parent);
      if (nextParent === parent) return resolved;
      parent = nextParent;
    }
  }

  return resolved;
}

function assertInsideRoot(resolved: string, root: string): void {
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Path must stay within workspace root: ${root}`);
  }
}

function assertRealpathContained(target: string, root: string): void {
  const realTarget = realpathSync(target);
  const realRoot = realpathSync(root);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new Error(`Path escapes workspace root via symlink: ${root}`);
  }
}
