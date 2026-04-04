const MAX_ACTIVE_SESSIONS = 100;

interface CachedSession {
  sessionId: string;
  lastAccess: number;
  streaming: boolean;
}

export class SessionCache {
  private cache = new Map<string, CachedSession>();

  private evictIfNeeded(): void {
    if (this.cache.size <= MAX_ACTIVE_SESSIONS) return;

    let oldestSessionId: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [sessionId, entry] of this.cache) {
      if (!entry.streaming && entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestSessionId = sessionId;
      }
    }

    if (oldestSessionId) {
      this.cache.delete(oldestSessionId);
    }
  }

  touch(sessionId: string, streaming = false): void {
    const entry = this.cache.get(sessionId);

    if (entry) {
      entry.lastAccess = Date.now();
      entry.streaming = streaming;
      return;
    }

    this.cache.set(sessionId, {
      sessionId,
      lastAccess: Date.now(),
      streaming,
    });

    this.evictIfNeeded();
  }

  isActive(sessionId: string): boolean {
    return this.cache.has(sessionId);
  }

  setStreaming(sessionId: string, streaming: boolean): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    entry.streaming = streaming;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const sessionCache = new SessionCache();
