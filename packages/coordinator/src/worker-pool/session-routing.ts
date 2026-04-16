export const sessionRouting = {
  route(sessionId: string, workerCount: number): number {
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
      hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
    }
    return hash % workerCount;
  },
};
