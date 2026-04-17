import type { WorkerBootstrap } from "@openomni/protocol";
import { SessionRouting } from "./session-routing";
import { WorkerSupervisor, type ToolCallParams, type ToolCallResult } from "./supervisor";

export type { ToolCallParams, ToolCallResult };

export type WorkerPoolConfig = {
  size?: number;
  workerScript: string;
  socketDir?: string;
  bootstrap?: WorkerBootstrap.Bootstrap;
  onToolCall?: (params: ToolCallParams) => Promise<ToolCallResult>;
  onWorkerSnapshot?: (workerId: number, snapshot: WorkerBootstrap.WorkerSnapshot) => void;
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
    (_, i) =>
      new WorkerSupervisor(
        i,
        config.workerScript,
        socketDir,
        config.bootstrap,
        config.onToolCall,
        config.onWorkerSnapshot,
      ),
  );

  return {
    async dispatch(sessionId, runId, params) {
      const index = SessionRouting.route(sessionId, size);
      try {
        return await workers[index].dispatch(runId, { sessionId, ...params });
      } finally {
        SessionRouting.complete(sessionId);
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
