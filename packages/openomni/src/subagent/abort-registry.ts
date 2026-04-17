export type AbortControllerEntry = {
  controller: AbortController;
};

export const AbortControllerRegistry = new Map<string, Map<string, AbortControllerEntry>>();

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

  const entry: AbortControllerEntry = { controller: new AbortController() };
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
