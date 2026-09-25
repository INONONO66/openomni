type DedupeToken = symbol;

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
