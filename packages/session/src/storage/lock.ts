import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

interface LockOptions {
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

interface LockInfo {
  pid: number;
  timestamp: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = readFileSync(join(lockPath, "info.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid === "number" && typeof parsed.timestamp === "number") {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

function isStale(lockPath: string, staleMs: number): boolean {
  const info = readLockInfo(lockPath);
  if (info) {
    return info.timestamp + staleMs < Date.now();
  }
  // info.json missing or unreadable — fall back to directory mtime.
  // A freshly-created lock dir has a recent mtime (not stale → no race).
  // A crash-orphaned lock dir will age past staleMs (stale → self-healing).
  try {
    const mtime = statSync(lockPath).mtimeMs;
    return mtime + staleMs < Date.now();
  } catch {
    return false;
  }
}

function forceRemoveLock(lockPath: string): void {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {}
}

function writeLockInfo(lockPath: string): void {
  const info: LockInfo = { pid: process.pid, timestamp: Date.now() };
  writeFileSync(join(lockPath, "info.json"), JSON.stringify(info), "utf-8");
}

export namespace FileLock {
  export function acquire(lockPath: string, options?: LockOptions): void {
    const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
    const startTime = Date.now();

    while (true) {
      try {
        mkdirSync(lockPath);
        writeLockInfo(lockPath);
        return;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          if (isStale(lockPath, staleMs)) {
            forceRemoveLock(lockPath);
            continue;
          }

          if (Date.now() - startTime > timeoutMs) {
            throw new Error(`FileLock: timeout acquiring lock after ${timeoutMs}ms: ${lockPath}`);
          }

          syncSleep(pollMs);
          continue;
        }
        throw err;
      }
    }
  }

  export function release(lockPath: string): void {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {}
  }

  export function withLock<T>(lockPath: string, fn: () => T, options?: LockOptions): T {
    acquire(lockPath, options);
    try {
      return fn();
    } finally {
      try {
        release(lockPath);
      } catch {}
    }
  }

  export function isLocked(lockPath: string, options?: Pick<LockOptions, "staleMs">): boolean {
    if (!existsSync(lockPath)) return false;
    const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
    return !isStale(lockPath, staleMs);
  }
}
