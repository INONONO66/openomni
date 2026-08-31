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

export type DedupeToken = symbol;

export class Dedupe {
  private readonly seen = new Map<string, { at: number; token: DedupeToken }>();
  private readonly maxAge: number;
  private readonly maxSize: number;
  private ops = 0;

  constructor(maxAge = 5 * 60_000, maxSize = 10_000) {
    this.maxAge = maxAge;
    this.maxSize = maxSize;
  }

  forget(id: string, token: DedupeToken): void {
    if (this.seen.get(id)?.token === token) this.seen.delete(id);
  }

  acquire(
    id: string,
  ): { readonly duplicate: true } | { readonly duplicate: false; readonly token: DedupeToken } {
    // prune every 100 operations to amortize cost
    if (++this.ops >= 100) {
      this.ops = 0;
      this.prune();
    }

    const now = Date.now();
    const existing = this.seen.get(id);
    // allow re-processing if the previous entry has expired
    if (existing !== undefined && now - existing.at <= this.maxAge) return { duplicate: true };

    const token = Symbol("dedupe-generation");
    this.seen.set(id, { at: now, token });
    return { duplicate: false, token };
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAge;
    for (const [id, entry] of this.seen) {
      if (entry.at < cutoff) this.seen.delete(id);
    }

    while (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
