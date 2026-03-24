export interface MemoryEntry {
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  storedAt: string; // ISO timestamp
}

export interface MemoryResult {
  key: string;
  content: string;
  score: number; // 0.0 to 1.0
  metadata?: Record<string, unknown>;
}

export interface Memory {
  store(
    key: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  retrieve(
    query: string,
    options?: { limit?: number; threshold?: number },
  ): Promise<MemoryResult[]>;
  clear(): Promise<void>;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersectionSize = 0;
  for (const word of a) {
    if (b.has(word)) intersectionSize++;
  }

  const unionSize = a.size + b.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

export class InMemoryMemory implements Memory {
  private entries: MemoryEntry[] = [];

  async store(
    key: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.entries.push({
      key,
      content,
      metadata,
      storedAt: new Date().toISOString(),
    });
  }

  async retrieve(
    query: string,
    options?: { limit?: number; threshold?: number },
  ): Promise<MemoryResult[]> {
    const limit = options?.limit ?? 10;
    const threshold = options?.threshold ?? 0.0;
    const queryTokens = tokenize(query);

    const scored: MemoryResult[] = this.entries
      .map((entry) => ({
        key: entry.key,
        content: entry.content,
        score: jaccardSimilarity(queryTokens, tokenize(entry.content)),
        metadata: entry.metadata,
      }))
      .filter((r) => r.score >= threshold);

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  async clear(): Promise<void> {
    this.entries = [];
  }
}
