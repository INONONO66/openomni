import { sessionRouting } from "./session-routing.js";
import { WorkerSupervisor } from "./supervisor.js";

export type WorkerPoolConfig = {
  size?: number;
  workerScript: string;
  socketDir?: string;
};

export type WorkerPool = {
  dispatch(sessionId: string, runId: string, params: Record<string, unknown>): Promise<unknown>;
  getStats(): { workers: number; active: number; idle: number; ready: number };
  waitUntilReady(timeoutMs?: number): Promise<void>;
  killWorker(index: number): void;
  shutdown(): Promise<void>;
};

export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  const size = config.size ?? 8;
  const socketDir = config.socketDir ?? "/tmp";

  const workers: WorkerSupervisor[] = Array.from(
    { length: size },
    (_, i) => new WorkerSupervisor(i, config.workerScript, socketDir),
  );

  return {
    async dispatch(sessionId, runId, params) {
      const index = sessionRouting.route(sessionId, size);
      try {
        return await workers[index].dispatch(runId, { sessionId, ...params });
      } finally {
        sessionRouting.complete(sessionId);
      }
    },
    getStats() {
      return {
        workers: size,
        active: workers.filter((w) => w.isActive()).length,
        idle: workers.filter((w) => !w.isActive()).length,
        ready: workers.filter((w) => w.isReady()).length,
      };
    },
    async waitUntilReady(timeoutMs = 15_000) {
      await Promise.all(workers.map((w) => w.waitReady(timeoutMs)));
    },
    killWorker(index) {
      workers[index]?.forceKill();
    },
    async shutdown() {
      await Promise.all(workers.map((w) => w.stop()));
    },
  };
}
