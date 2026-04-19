import type { Storage } from "@openomni/protocol";

export function memoryPlanAdapter(): Storage.PlanSubAdapter {
  const store = new Map<
    string,
    { content: string; version: number; createdAt: number; updatedAt: number }
  >();
  return {
    async write(id, content) {
      const existing = store.get(id);
      const now = Date.now();
      if (existing) {
        existing.content = content;
        existing.version++;
        existing.updatedAt = now;
      } else {
        store.set(id, { content, version: 1, createdAt: now, updatedAt: now });
      }
    },
    async read(id) {
      return store.get(id);
    },
    async delete(id) {
      store.delete(id);
    },
    async list() {
      return [...store.entries()].map(([id, entry]) => ({
        id,
        version: entry.version,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
    },
  };
}
