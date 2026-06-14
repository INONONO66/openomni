import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Waiter = { runId: string; resolve: () => void; reject: (e: Error) => void };
type LocalLock = { runId: string; depth: number; pending: boolean };
type LockOwnerMeta = { runId: string; pid: number; acquiredAt: number };
type UnsafeWorkspace = { reason: string; markedAt: number; token?: string };

const active = new Map<string, LocalLock>();
const queue = new Map<string, Waiter[]>();
const unsafe = new Map<string, UnsafeWorkspace>();
const settledUnsafeTokens = new Map<string, number>();
const LOCK_ROOT = join(tmpdir(), "openomni-workspace-locks");
const OWNER_FILE = "owner.json";
const STALE_GRACE_MS = 1_000;
const SETTLED_TOKEN_TTL_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError(): Error {
  const error = new Error("Tool execution aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function lockPath(workspace: string): string {
  return join(LOCK_ROOT, lockKey(workspace));
}

function lockKey(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex");
}

function unsafeTokenKey(workspace: string, token: string): string {
  return `${lockKey(workspace)}:${token}`;
}

function pruneSettledUnsafeTokens(): void {
  const now = Date.now();
  for (const [key, settledAt] of settledUnsafeTokens) {
    if (now - settledAt >= SETTLED_TOKEN_TTL_MS) settledUnsafeTokens.delete(key);
  }
}

function ownerFilePath(workspace: string): string {
  return join(lockPath(workspace), OWNER_FILE);
}

function unsafeFilePath(workspace: string): string {
  return join(LOCK_ROOT, `${lockKey(workspace)}.unsafe.json`);
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

function readUnsafeMeta(workspace: string): UnsafeWorkspace | undefined {
  const local = unsafe.get(workspace);
  if (local) return local;
  try {
    const parsed = JSON.parse(readFileSync(unsafeFilePath(workspace), "utf-8")) as UnsafeWorkspace;
    unsafe.set(workspace, parsed);
    return parsed;
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

async function acquireExternal(
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
      await sleepAbortable(25, signal);
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
  const unsafeState = readUnsafeMeta(workspace);
  if (unsafeState) {
    rejectWaiters(workspace, unsafeWorkspaceError(workspace, unsafeState));
    return;
  }

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

function unsafeWorkspaceError(workspace: string, state: UnsafeWorkspace): Error {
  return new Error(`workspace marked unsafe for "${workspace}": ${state.reason}`);
}

function rejectWaiters(workspace: string, error: Error): void {
  const waiters = queue.get(workspace);
  if (!waiters) return;
  queue.delete(workspace);
  for (const waiter of waiters) waiter.reject(error);
}

export namespace WorkspaceLock {
  export async function acquire(
    workspace: string,
    runId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const unsafeState = readUnsafeMeta(workspace);
    if (unsafeState) throw unsafeWorkspaceError(workspace, unsafeState);

    const local = active.get(workspace);
    if (local && !local.pending && local.runId === runId) {
      local.depth++;
      return;
    }

    if (!local && (queue.get(workspace)?.length ?? 0) === 0) {
      await acquireExternal(workspace, runId, timeoutMs, signal);
      if (signal?.aborted) {
        releaseExternal(workspace, runId);
        throw createAbortError();
      }
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
      const onAbort = () => {
        const waiters = queue.get(workspace);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) queue.delete(workspace);
        }
        reject(createAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const complete = entry.resolve;
      entry.resolve = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        complete();
      };
      const fail = entry.reject;
      entry.reject = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fail(error);
      };

      const waiters = queue.get(workspace) ?? [];
      waiters.push(entry);
      queue.set(workspace, waiters);
    });

    const remaining = Math.max(0, timeoutMs - (Date.now() - start));
    try {
      const unsafeState = readUnsafeMeta(workspace);
      if (unsafeState) throw unsafeWorkspaceError(workspace, unsafeState);
      await acquireExternal(workspace, runId, remaining, signal);
      if (signal?.aborted) {
        releaseExternal(workspace, runId);
        throw createAbortError();
      }
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

  export function markUnsafe(workspace: string, reason: string, token?: string): void {
    if (token !== undefined) {
      pruneSettledUnsafeTokens();
      if (settledUnsafeTokens.has(unsafeTokenKey(workspace, token))) return;
    }

    const state: UnsafeWorkspace = {
      reason,
      markedAt: Date.now(),
      ...(token !== undefined ? { token } : {}),
    };
    unsafe.set(workspace, state);
    mkdirSync(LOCK_ROOT, { recursive: true });
    writeFileSync(unsafeFilePath(workspace), JSON.stringify(state), "utf-8");
    rejectWaiters(workspace, unsafeWorkspaceError(workspace, state));
  }

  export function clearUnsafe(workspace: string, token?: string): void {
    const state = readUnsafeMeta(workspace);
    if (token !== undefined) {
      pruneSettledUnsafeTokens();
      settledUnsafeTokens.set(unsafeTokenKey(workspace, token), Date.now());
      if (state?.token !== token) return;
    }

    unsafe.delete(workspace);
    try {
      unlinkSync(unsafeFilePath(workspace));
    } catch {
      // No unsafe marker exists.
    }
  }
}
