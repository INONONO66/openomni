// rootSessionId → worker index; persists until all sessions in that tree complete
const affinityMap = new Map<string, number>();
// worker index → number of active session trees assigned
const workerLoad = new Map<number, number>();

export const SessionRouting = {
  route(rootSessionId: string, workerCount: number): number {
    const existing = affinityMap.get(rootSessionId);
    if (existing !== undefined) return existing;

    let minLoad = Infinity;
    let chosen = 0;
    for (let i = 0; i < workerCount; i++) {
      const load = workerLoad.get(i) ?? 0;
      if (load < minLoad) {
        minLoad = load;
        chosen = i;
      }
    }

    affinityMap.set(rootSessionId, chosen);
    workerLoad.set(chosen, (workerLoad.get(chosen) ?? 0) + 1);
    return chosen;
  },

  complete(rootSessionId: string): void {
    const index = affinityMap.get(rootSessionId);
    if (index === undefined) return;

    const current = workerLoad.get(index) ?? 0;
    const next = current - 1;
    if (next <= 0) {
      workerLoad.delete(index);
    } else {
      workerLoad.set(index, next);
    }
    affinityMap.delete(rootSessionId);
  },
};
