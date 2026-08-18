export class Dedupe {
  private readonly seen = new Map<string, number>();
  private readonly maxAge: number;
  private readonly maxSize: number;
  private ops = 0;

  constructor(maxAge = 5 * 60_000, maxSize = 10_000) {
    this.maxAge = maxAge;
    this.maxSize = maxSize;
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
