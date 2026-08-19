import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";

export function resolveContainedPath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  // Fail closed (audit A T4d): the root must itself resolve to a real path
  // BEFORE any containment check — otherwise symlink containment silently
  // degrades to a lexical-only check when the root is missing.
  const realRoot = realRootOrThrow(root);
  const resolved = resolve(root, inputPath);
  assertInsideRoot(resolved, root);

  try {
    assertRealpathContained(resolved, realRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    assertRealpathContained(dirname(resolved), realRoot);
  }

  return resolved;
}

export function resolveContainedPathForCreate(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const realRoot = realRootOrThrow(root);
  const resolved = resolve(root, inputPath);
  assertInsideRoot(resolved, root);

  try {
    assertRealpathContained(resolved, realRoot);
    return resolved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let parent = dirname(resolved);
  while (parent !== root) {
    try {
      assertRealpathContained(parent, realRoot);
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

/**
 * The real (symlink-resolved) workspace root, or a hard failure. A root that
 * cannot be resolved must never let containment fall back to a lexical-only
 * check (audit A T4d) — deny instead.
 */
function realRootOrThrow(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    throw new Error(`Workspace root does not resolve — path containment fails closed: ${root}`);
  }
}

function assertRealpathContained(target: string, realRoot: string): void {
  const realTarget = realpathSync(target);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new Error(`Path escapes workspace root via symlink: ${realRoot}`);
  }
}
