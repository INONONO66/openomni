import { Bus } from "@openomni/session";
import { Execution, Subagent, type WorkerBootstrap } from "@openomni/protocol";
import {
  createWorkerPool,
  type WorkerPool,
  recoverInterruptedRuns as _recoverInterruptedRuns,
  type RecoveryResult,
} from "@openomni/coordinator";

export type CoordinatorConfig = {
  workerScript: string;
  workerCount?: number;
  socketDir?: string;
  bootstrap?: WorkerBootstrap.Bootstrap;
};

export type ExecutionCoordinator = {
  dispatch(sessionTreeId: string, request: Execution.Request): Promise<Execution.Result>;
  getStats(): { workers: number; active: number; idle: number; ready: number; activeRuns: number };
  waitUntilReady(timeoutMs?: number): Promise<void>;
  recoverInterruptedRuns(): Promise<RecoveryResult>;
  shutdown(): Promise<void>;
};

export function createExecutionCoordinator(config: CoordinatorConfig): ExecutionCoordinator {
  const workerPool: WorkerPool = createWorkerPool({
    workerScript: config.workerScript,
    size: config.workerCount,
    socketDir: config.socketDir,
    bootstrap: config.bootstrap,
  });

  const activeRuns = new Set<string>();
  let isDraining = false;

  return {
    async dispatch(sessionTreeId, request) {
      if (isDraining) {
        throw new Error("Execution coordinator is draining");
      }

      activeRuns.add(request.runId);

      Bus.publish(Subagent.Events.WorkerRunStarted, {
        traceId: crypto.randomUUID(),
        sessionId: request.sessionId,
        runId: request.runId,
        time: Date.now(),
        payload: {
          sessionId: request.sessionId,
          runId: request.runId,
          title: request.prompt.slice(0, 80),
        },
      });

      try {
        const raw = await workerPool.dispatch(sessionTreeId, request.runId, { ...request });
        const result = Execution.Result.parse(raw);

        Bus.publish(Subagent.Events.WorkerRunCompleted, {
          traceId: crypto.randomUUID(),
          sessionId: request.sessionId,
          runId: request.runId,
          time: Date.now(),
          payload: {
            sessionId: request.sessionId,
            runId: request.runId,
            status: result.status as Subagent.WorkerRunStatus,
          },
        });

        return result;
      } catch (err) {
        Bus.publish(Subagent.Events.WorkerRunFailed, {
          traceId: crypto.randomUUID(),
          sessionId: request.sessionId,
          runId: request.runId,
          time: Date.now(),
          payload: {
            sessionId: request.sessionId,
            runId: request.runId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        throw err;
      } finally {
        activeRuns.delete(request.runId);
      }
    },

    getStats() {
      return { ...workerPool.getStats(), activeRuns: activeRuns.size };
    },

    async waitUntilReady(timeoutMs) {
      await workerPool.waitUntilReady(timeoutMs);
    },

    async recoverInterruptedRuns() {
      return _recoverInterruptedRuns();
    },

    async shutdown() {
      isDraining = true;

      const deadline = Date.now() + 60_000;
      while (activeRuns.size > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }

      await workerPool.shutdown();
    },
  };
}
