import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Waiter = { runId: string; resolve: () => void; reject: (e: Error) => void };
type LocalLock = { runId: string; depth: number; pending: boolean };
type LockOwnerMeta = { runId: string; pid: number; acquiredAt: number };

const active = new Map<string, LocalLock>();
const queue = new Map<string, Waiter[]>();
const LOCK_ROOT = join(tmpdir(), "openomni-workspace-locks");
const OWNER_FILE = "owner.json";
const STALE_GRACE_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath(workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex");
  return join(LOCK_ROOT, key);
}

function ownerFilePath(workspace: string): string {
  return join(lockPath(workspace), OWNER_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function readOwnerMeta(workspace: string): LockOwnerMeta | undefined {
  try {
    return JSON.parse(readFileSync(ownerFilePath(workspace), "utf-8")) as LockOwnerMeta;
  } catch {
    return undefined;
  }
}

function removeLockDir(workspace: string): void {
  rmSync(lockPath(workspace), { recursive: true, force: true });
}

function shouldReapStaleLock(workspace: string): boolean {
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

async function acquireExternal(workspace: string, runId: string, timeoutMs: number): Promise<void> {
  mkdirSync(LOCK_ROOT, { recursive: true });
  const start = Date.now();

  for (;;) {
    try {
      const path = lockPath(workspace);
      mkdirSync(path);
      try {
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
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
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
      await sleep(25);
    }
  }
}

function releaseExternal(workspace: string, runId: string): void {
  const meta = readOwnerMeta(workspace);
  if (!meta) return;
  if (meta.pid !== process.pid || meta.runId !== runId) return;
  removeLockDir(workspace);
}

function wakeNextWaiter(workspace: string): void {
  const waiters = queue.get(workspace);
  if (!waiters || waiters.length === 0) {
    queue.delete(workspace);
    return;
  }

  const next = waiters.shift();
  if (waiters.length === 0) queue.delete(workspace);
  if (!next) return;

  active.set(workspace, { runId: next.runId, depth: 0, pending: true });
  next.resolve();
}

export namespace WorkspaceLock {
  export async function acquire(
    workspace: string,
    runId: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const local = active.get(workspace);
    if (local && !local.pending && local.runId === runId) {
      local.depth++;
      return;
    }

    if (!local && (queue.get(workspace)?.length ?? 0) === 0) {
      await acquireExternal(workspace, runId, timeoutMs);
      active.set(workspace, { runId, depth: 1, pending: false });
      return;
    }

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        runId,
        resolve: () => resolve(),
        reject,
      };

      const timer = setTimeout(() => {
        const waiters = queue.get(workspace);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) queue.delete(workspace);
        }
        reject(new Error(`workspace lock timeout after ${timeoutMs}ms for "${workspace}"`));
      }, timeoutMs);

      const complete = entry.resolve;
      entry.resolve = () => {
        clearTimeout(timer);
        complete();
      };
      const fail = entry.reject;
      entry.reject = (error) => {
        clearTimeout(timer);
        fail(error);
      };

      const waiters = queue.get(workspace) ?? [];
      waiters.push(entry);
      queue.set(workspace, waiters);
    });

    const remaining = Math.max(0, timeoutMs - (Date.now() - start));
    try {
      await acquireExternal(workspace, runId, remaining);
      active.set(workspace, { runId, depth: 1, pending: false });
    } catch (error) {
      const current = active.get(workspace);
      if (current?.runId === runId && current.pending) {
        active.delete(workspace);
        wakeNextWaiter(workspace);
      }
      throw error;
    }
  }

  export function release(workspace: string, runId: string): void {
    const local = active.get(workspace);
    if (!local || local.runId !== runId || local.pending) return;
    if (local.depth > 1) {
      local.depth--;
      return;
    }

    active.delete(workspace);
    releaseExternal(workspace, runId);
    wakeNextWaiter(workspace);
  }
}
