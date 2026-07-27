import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepAbortable, throwIfAborted } from "./workspace-lock-abort.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";
import {
  LOCK_ROOT,
  OWNER_FILE,
  STALE_GRACE_MS,
  type LockOwnerMeta,
} from "./workspace-lock-types.js";

export function lockKey(workspace: WorkspaceIdentity): string {
  return createHash("sha256").update(workspace.workspaceId).digest("hex");
}

function lockPath(workspace: WorkspaceIdentity): string {
  return join(LOCK_ROOT, lockKey(workspace));
}

function ownerFilePath(workspace: WorkspaceIdentity): string {
  return join(lockPath(workspace), OWNER_FILE);
}

function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLockOwnerMeta(value: unknown): value is LockOwnerMeta {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.pid === "number" &&
    typeof value.acquiredAt === "number"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

function readOwnerMeta(workspace: WorkspaceIdentity): LockOwnerMeta | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerFilePath(workspace), "utf-8"));
    return isLockOwnerMeta(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function removeLockDir(workspace: WorkspaceIdentity): void {
  rmSync(lockPath(workspace), { recursive: true, force: true });
}

function shouldReapStaleLock(workspace: WorkspaceIdentity): boolean {
  const meta = readOwnerMeta(workspace);
  if (meta) {
    return !isProcessAlive(meta.pid);
  }

  try {
    const ageMs = Date.now() - statSync(lockPath(workspace)).mtimeMs;
    return ageMs >= STALE_GRACE_MS;
  } catch {
    return false;
  }
}

export async function acquireExternal(
  workspace: WorkspaceIdentity,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(LOCK_ROOT, { recursive: true });
  const start = Date.now();

  for (;;) {
    throwIfAborted(signal);
    try {
      const path = lockPath(workspace);
      mkdirSync(path);
      try {
        throwIfAborted(signal);
        writeFileSync(
          join(path, OWNER_FILE),
          JSON.stringify({ runId, pid: process.pid, acquiredAt: Date.now() }),
          "utf-8",
        );
        return;
      } catch (error) {
        removeLockDir(workspace);
        throw error;
      }
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "EEXIST") {
        throw error;
      }

      if (shouldReapStaleLock(workspace)) {
        removeLockDir(workspace);
        continue;
      }

      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `workspace lock timeout after ${timeoutMs}ms for "${workspace.workspaceId}"`,
        );
      }
      await sleepAbortable(25, signal);
    }
  }
}

export function releaseExternal(workspace: WorkspaceIdentity, runId: string): void {
  const meta = readOwnerMeta(workspace);
  if (!meta) return;
  if (meta.pid !== process.pid || meta.runId !== runId) return;
  removeLockDir(workspace);
}
