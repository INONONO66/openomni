import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepAbortable, throwIfAborted } from "./workspace-lock-abort.js";
import {
  LOCK_ROOT,
  OWNER_FILE,
  STALE_GRACE_MS,
  type LockOwnerMeta,
} from "./workspace-lock-types.js";

export function lockKey(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex");
}

function lockPath(workspace: string): string {
  return join(LOCK_ROOT, lockKey(workspace));
}

function ownerFilePath(workspace: string): string {
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

function readOwnerMeta(workspace: string): LockOwnerMeta | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerFilePath(workspace), "utf-8"));
    return isLockOwnerMeta(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type OwnerRead =
  | { readonly status: "valid"; readonly meta: LockOwnerMeta }
  /** No owner file yet (ENOENT): a lock dir created but not stamped, or a pre-owner-format lock. */
  | { readonly status: "missing" }
  /** Owner file present but unreadable/unparseable — its holder may be live. */
  | { readonly status: "unreadable" };

function readOwner(workspace: string): OwnerRead {
  let raw: string;
  try {
    raw = readFileSync(ownerFilePath(workspace), "utf-8");
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { status: "missing" } : { status: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLockOwnerMeta(parsed) ? { status: "valid", meta: parsed } : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
}

function removeLockDir(workspace: string): void {
  rmSync(lockPath(workspace), { recursive: true, force: true });
}

function shouldReapStaleLock(workspace: string): boolean {
  const owner = readOwner(workspace);
  if (owner.status === "valid") {
    return !isProcessAlive(owner.meta.pid);
  }
  if (owner.status === "unreadable") {
    // Fail closed (audit A T4a): an owner file we cannot read or parse may
    // belong to a LIVE holder — treat it as live and never reap it on the
    // mtime grace path. Grace applies ONLY to a genuinely-absent owner file.
    return false;
  }

  // status === "missing": no owner file at all — the mtime grace decides.
  try {
    const ageMs = Date.now() - statSync(lockPath(workspace)).mtimeMs;
    return ageMs >= STALE_GRACE_MS;
  } catch {
    return false;
  }
}

export async function acquireExternal(
  workspace: string,
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
        // Atomic owner publish (audit A T4a): write a temp file inside the
        // already-won lock dir, then rename it into place. A hard crash
        // mid-acquisition therefore leaves EITHER no OWNER_FILE (→ "missing",
        // grace-reapable) or an unpublished ".tmp" — never a half-written
        // OWNER_FILE. So "unreadable" can only mean genuine corruption/EACCES
        // (fail-closed-live), and a crash can never deadlock the lock.
        const tmpPath = join(path, `${OWNER_FILE}.tmp`);
        writeFileSync(
          tmpPath,
          JSON.stringify({ runId, pid: process.pid, acquiredAt: Date.now() }),
          "utf-8",
        );
        renameSync(tmpPath, join(path, OWNER_FILE));
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
        throw new Error(`workspace lock timeout after ${timeoutMs}ms for "${workspace}"`);
      }
      await sleepAbortable(25, signal);
    }
  }
}

export function releaseExternal(workspace: string, runId: string): void {
  const meta = readOwnerMeta(workspace);
  if (!meta) return;
  if (meta.pid !== process.pid || meta.runId !== runId) return;
  removeLockDir(workspace);
}
