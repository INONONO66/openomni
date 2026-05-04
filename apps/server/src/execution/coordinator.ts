import { Execution, type Tool, type WorkerBootstrap } from "@openomni/protocol";
import {
  createWorkerPool,
  type WorkerPool,
  recoverInterruptedRuns as _recoverInterruptedRuns,
  type RecoveryResult,
} from "@openomni/coordinator";
import type { ToolProvider } from "@openomni/openomni";

export type CoordinatorConfig = {
  workerScript: string;
  workerCount?: number;
  socketDir?: string;
  bootstrap?: WorkerBootstrap.Bootstrap;
  toolDispatcher?: Map<string, (call: Tool.Call) => Promise<Tool.Result>>;
};

export function buildToolDispatcher(
  providers: ToolProvider[],
): Map<string, (call: Tool.Call) => Promise<Tool.Result>> {
  const dispatcher = new Map<string, (call: Tool.Call) => Promise<Tool.Result>>();

  for (const provider of providers) {
    for (const tool of provider.listTools()) {
      const canonicalName = tool.spec.name;
      if (dispatcher.has(canonicalName)) {
        throw new Error(`Duplicate tool in dispatcher: "${canonicalName}"`);
      }
      dispatcher.set(canonicalName, (call) => provider.execute(call));
    }
  }

  return dispatcher;
}

export type ExecutionCoordinator = {
  dispatch(sessionTreeId: string, request: Execution.Request): Promise<Execution.Result>;
  getStats(): { workers: number; active: number; idle: number; ready: number; activeRuns: number };
  getWorkerSnapshots(): Map<number, WorkerBootstrap.WorkerSnapshot>;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  recoverInterruptedRuns(): Promise<RecoveryResult>;
  shutdown(): Promise<void>;
};

export function createExecutionCoordinator(config: CoordinatorConfig): ExecutionCoordinator {
  const workerSnapshots = new Map<number, WorkerBootstrap.WorkerSnapshot>();
  const { toolDispatcher } = config;

  const workerPool: WorkerPool = createWorkerPool({
    workerScript: config.workerScript,
    size: config.workerCount,
    socketDir: config.socketDir,
    bootstrap: config.bootstrap,
    onToolCall: toolDispatcher
      ? async (params) => {
          const call: Tool.Call = {
            id: params.callId,
            tool: params.tool,
            input: params.input,
          };
          const handler = toolDispatcher.get(params.tool);
          if (!handler) {
            return {
              id: params.callId,
              toolCallId: params.callId,
              output: `Unknown tool: ${params.tool}`,
              isError: true,
            };
          }
          const result = await handler(call);
          return {
            id: result.id,
            toolCallId: result.toolCallId,
            output: result.output,
            isError: result.isError,
          };
        }
      : undefined,
    onWorkerSnapshot: (workerId, snapshot) => {
      workerSnapshots.set(workerId, snapshot);
    },
  });

  const activeRuns = new Set<string>();
  let isDraining = false;

  return {
    async dispatch(sessionTreeId, request) {
      if (isDraining) {
        throw new Error("Execution coordinator is draining");
      }

      activeRuns.add(request.runId);

      try {
        const raw = await workerPool.dispatch(sessionTreeId, request.runId, { ...request });
        return Execution.Result.parse(raw);
      } finally {
        activeRuns.delete(request.runId);
      }
    },

    getStats() {
      return { ...workerPool.getStats(), activeRuns: activeRuns.size };
    },

    getWorkerSnapshots() {
      return workerSnapshots;
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
