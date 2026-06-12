type SessionAffinity = {
  readonly workerIndex: number;
  refCount: number;
};

export type SessionRouter = {
  route(rootSessionId: string, workerCount: number): number;
  complete(rootSessionId: string): void;
  get(rootSessionId: string): number | undefined;
  assign(rootSessionId: string, workerIndex: number): void;
  forgetWorker(workerIndex: number): void;
  clear(): void;
};

export function createSessionRouting(): SessionRouter {
  const affinityMap = new Map<string, SessionAffinity>();
  const workerLoad = new Map<number, number>();

  function decrementWorkerLoad(workerIndex: number): void {
    const current = workerLoad.get(workerIndex) ?? 0;
    const next = current - 1;
    if (next <= 0) {
      workerLoad.delete(workerIndex);
      return;
    }
    workerLoad.set(workerIndex, next);
  }

  return {
    route(rootSessionId: string, workerCount: number): number {
      const existing = affinityMap.get(rootSessionId);
      if (existing !== undefined) {
        existing.refCount += 1;
        return existing.workerIndex;
      }

      let minLoad = Infinity;
      let chosen = 0;
      for (let i = 0; i < workerCount; i++) {
        const load = workerLoad.get(i) ?? 0;
        if (load < minLoad) {
          minLoad = load;
          chosen = i;
        }
      }

      affinityMap.set(rootSessionId, { workerIndex: chosen, refCount: 1 });
      workerLoad.set(chosen, (workerLoad.get(chosen) ?? 0) + 1);
      return chosen;
    },

    complete(rootSessionId: string): void {
      const affinity = affinityMap.get(rootSessionId);
      if (affinity === undefined) return;

      affinity.refCount -= 1;
      if (affinity.refCount > 0) return;

      decrementWorkerLoad(affinity.workerIndex);
      affinityMap.delete(rootSessionId);
    },

    get(rootSessionId: string): number | undefined {
      return affinityMap.get(rootSessionId)?.workerIndex;
    },

    assign(rootSessionId: string, workerIndex: number): void {
      const existing = affinityMap.get(rootSessionId);
      if (existing?.workerIndex === workerIndex) return;
      if (existing !== undefined) decrementWorkerLoad(existing.workerIndex);

      affinityMap.set(rootSessionId, { workerIndex, refCount: existing?.refCount ?? 1 });
      workerLoad.set(workerIndex, (workerLoad.get(workerIndex) ?? 0) + 1);
    },

    forgetWorker(workerIndex: number): void {
      for (const [rootSessionId, affinity] of affinityMap.entries()) {
        if (affinity.workerIndex === workerIndex) affinityMap.delete(rootSessionId);
      }
      workerLoad.delete(workerIndex);
    },

    clear(): void {
      affinityMap.clear();
      workerLoad.clear();
    },
  };
}

export const SessionRouting = createSessionRouting();
