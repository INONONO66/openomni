export type AbortControllerEntry = {
  controller: AbortController;
  readonly createdAt: number;
};

export const MAX_ENTRY_AGE_MS = 30 * 60 * 1000;

export const AbortControllerRegistry = new Map<string, Map<string, AbortControllerEntry>>();

let sweepTimer: ReturnType<typeof setInterval> | undefined;
let sweepRefCount = 0;

export function register(sessionId: string, runId: string): AbortControllerEntry {
  let sessionMap = AbortControllerRegistry.get(sessionId);
  if (!sessionMap) {
    sessionMap = new Map();
    AbortControllerRegistry.set(sessionId, sessionMap);
  }

  const existing = sessionMap.get(runId);
  if (existing && !existing.controller.signal.aborted) {
    return existing;
  }

  const entry: AbortControllerEntry = { controller: new AbortController(), createdAt: Date.now() };
  sessionMap.set(runId, entry);
  return entry;
}

export function get(sessionId: string, runId: string): AbortControllerEntry | undefined {
  return AbortControllerRegistry.get(sessionId)?.get(runId);
}

export function abort(sessionId: string, runId?: string): void {
  const sessionMap = AbortControllerRegistry.get(sessionId);
  if (!sessionMap) return;

  if (runId !== undefined) {
    const entry = sessionMap.get(runId);
    if (entry) {
      entry.controller.abort();
      sessionMap.delete(runId);
      if (sessionMap.size === 0) {
        AbortControllerRegistry.delete(sessionId);
      }
    }
  } else {
    for (const entry of sessionMap.values()) {
      entry.controller.abort();
    }
    AbortControllerRegistry.delete(sessionId);
  }
}

export function remove(sessionId: string, runId: string): void {
  const sessionMap = AbortControllerRegistry.get(sessionId);
  if (!sessionMap) return;

  sessionMap.delete(runId);
  if (sessionMap.size === 0) {
    AbortControllerRegistry.delete(sessionId);
  }
}

export function sweep(maxAgeMs: number = MAX_ENTRY_AGE_MS): number {
  const now = Date.now();
  let removed = 0;

  for (const [sessionId, sessionMap] of AbortControllerRegistry) {
    for (const [runId, entry] of sessionMap) {
      const stale = entry.controller.signal.aborted && now - entry.createdAt >= maxAgeMs;
      if (stale) {
        sessionMap.delete(runId);
        removed++;
      }
    }
    if (sessionMap.size === 0) {
      AbortControllerRegistry.delete(sessionId);
    }
  }

  return removed;
}

export function startSweep(intervalMs = 300_000): void {
  sweepRefCount++;
  if (sweepTimer !== undefined) return;
  sweepTimer = setInterval(sweep, intervalMs);
}

export function stopSweep(): void {
  sweepRefCount = Math.max(0, sweepRefCount - 1);
  if (sweepRefCount > 0 || sweepTimer === undefined) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}
