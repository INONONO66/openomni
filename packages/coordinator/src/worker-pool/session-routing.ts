type SessionAffinity = {
  readonly workerIndex: number;
  refCount: number;
};

// rootSessionId → worker affinity; persists until all sessions in that tree complete
const affinityMap = new Map<string, SessionAffinity>();
// worker index → number of active session trees assigned
const workerLoad = new Map<number, number>();

export const SessionRouting = {
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

    const current = workerLoad.get(affinity.workerIndex) ?? 0;
    const next = current - 1;
    if (next <= 0) {
      workerLoad.delete(affinity.workerIndex);
    } else {
      workerLoad.set(affinity.workerIndex, next);
    }
    affinityMap.delete(rootSessionId);
  },
};
