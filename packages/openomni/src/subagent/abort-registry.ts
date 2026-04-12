export type AbortControllerEntry = {
  controller: AbortController;
  activeRunId?: string;
};

export const AbortControllerRegistry = new Map<string, AbortControllerEntry>();

export function register(sessionId: string, runId?: string): AbortControllerEntry {
  const existing = AbortControllerRegistry.get(sessionId);
  if (existing && !existing.controller.signal.aborted) {
    existing.activeRunId = runId;
    return existing;
  }

  const entry: AbortControllerEntry = {
    controller: new AbortController(),
    activeRunId: runId,
  };
  AbortControllerRegistry.set(sessionId, entry);
  return entry;
}

export function get(sessionId: string): AbortControllerEntry | undefined {
  return AbortControllerRegistry.get(sessionId);
}

export function abort(sessionId: string): void {
  const entry = AbortControllerRegistry.get(sessionId);
  if (!entry) {
    return;
  }

  entry.controller.abort();
  AbortControllerRegistry.delete(sessionId);
}

export function remove(sessionId: string): void {
  AbortControllerRegistry.delete(sessionId);
}
