export class DedupeWindow<Value> {
  private readonly entries = new Map<string, { at: number; value: Promise<Value> }>();

  constructor(
    private readonly maxAge = 5 * 60_000,
    private readonly maxSize = 10_000,
  ) {}

  /**
   * Reuses one in-flight or completed result inside a bounded runtime window.
   * A failed operation is forgotten so a retry can make progress.
   */
  run(key: string, operation: () => Promise<Value>): Promise<Value> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing !== undefined && now - existing.at <= this.maxAge) return existing.value;
    if (existing !== undefined) this.entries.delete(key);

    const value = Promise.resolve().then(operation);
    this.entries.set(key, { at: now, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    this.prune(now);
    return value;
  }

  private prune(now: number): void {
    const cutoff = now - this.maxAge;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export class Dedupe {
  private readonly seen = new Map<string, number>();
  private readonly maxAge: number;
  private readonly maxSize: number;
  private ops = 0;

  constructor(maxAge = 5 * 60_000, maxSize = 10_000) {
    this.maxAge = maxAge;
    this.maxSize = maxSize;
  }

  forget(id: string): void {
    this.seen.delete(id);
  }

  isDuplicate(id: string): boolean {
    // prune every 100 operations to amortize cost
    if (++this.ops >= 100) {
      this.ops = 0;
      this.prune();
    }

    const existing = this.seen.get(id);
    if (existing !== undefined) {
      // allow re-processing if the previous entry has expired
      if (Date.now() - existing > this.maxAge) {
        this.seen.set(id, Date.now());
        return false;
      }
      return true;
    }
    this.seen.set(id, Date.now());
    return false;
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAge;
    for (const [id, time] of this.seen) {
      if (time < cutoff) this.seen.delete(id);
    }

    while (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
