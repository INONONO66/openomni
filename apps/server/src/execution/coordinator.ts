import { Execution, type Tool, type WorkerBootstrap } from "@openomni/protocol";
import {
  createWorkerManager,
  type InboundWaitParams,
  type InboundWaitResult,
  type ToolCallContext,
  type WorkerManager,
  recoverInterruptedRuns as _recoverInterruptedRuns,
  type RecoveryResult,
} from "@openomni/coordinator";
import type { ToolExecutionContext, ToolProvider } from "@openomni/openomni";

export type ToolDispatchHandler = (
  call: Tool.Call,
  context?: ToolExecutionContext,
) => Promise<Tool.Result>;

export type CoordinatorConfig = {
  workerScript: string;
  workerCount?: number;
  maxWorkers?: number;
  workerIdleTimeoutMs?: number;
  socketDir?: string;
  bootstrap?: WorkerBootstrap.Bootstrap;
  toolDispatcher?: Map<string, ToolDispatchHandler>;
  askResident?: (params: InboundWaitParams) => Promise<InboundWaitResult>;
};

export function buildToolDispatcher(providers: ToolProvider[]): Map<string, ToolDispatchHandler> {
  const dispatcher = new Map<string, ToolDispatchHandler>();

  for (const provider of providers) {
    for (const tool of provider.listTools()) {
      const canonicalName = tool.spec.name;
      if (dispatcher.has(canonicalName)) {
        throw new Error(`Duplicate tool in dispatcher: "${canonicalName}"`);
      }
      dispatcher.set(canonicalName, (call, context) => provider.execute(call, context));
    }
  }

  return dispatcher;
}

export type ExecutionCoordinator = {
  dispatch(sessionTreeId: string, request: Execution.Request): Promise<Execution.Result>;
  cancelRun(runId: string): Promise<unknown>;
  deliverMessage(sessionId: string, message: string, runId?: string): Promise<unknown>;
  getStats(): {
    workers: number;
    active: number;
    idle: number;
    ready: number;
    activeRuns: number;
    maxActiveWorkers: number;
  };
  waitUntilReady(timeoutMs?: number): Promise<void>;
  recoverInterruptedRuns(): Promise<RecoveryResult>;
  shutdown(): Promise<void>;
};

export function createExecutionCoordinator(config: CoordinatorConfig): ExecutionCoordinator {
  const { toolDispatcher } = config;

  const workerManager: WorkerManager = createWorkerManager({
    workerScript: config.workerScript,
    maxActiveWorkers: config.maxWorkers ?? config.workerCount,
    idleShutdownMs: config.workerIdleTimeoutMs,
    socketDir: config.socketDir,
    bootstrap: config.bootstrap,
    onInboundWait: config.askResident,
    onToolCall: toolDispatcher
      ? async (params, context?: ToolCallContext) => {
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
          const result = await handler(call, context);
          return {
            id: result.id,
            toolCallId: result.toolCallId,
            output: result.output,
            isError: result.isError,
          };
        }
      : undefined,
  });

  const activeRuns = new Set<string>();
  let isDraining = false;

  return {
    async dispatch(sessionTreeId, request) {
      if (isDraining) {
        throw new Error("Execution coordinator is draining");
      }

      if (activeRuns.has(request.runId)) {
        throw new Error(`run already active: ${request.runId}`);
      }

      activeRuns.add(request.runId);

      try {
        const raw = await workerManager.dispatch(sessionTreeId, request.runId, { ...request });
        return Execution.Result.parse(raw);
      } finally {
        activeRuns.delete(request.runId);
      }
    },

    async cancelRun(runId) {
      return workerManager.cancelRun(runId);
    },

    async deliverMessage(sessionId, message, runId) {
      return workerManager.deliverMessage(sessionId, message, runId);
    },

    getStats() {
      return { ...workerManager.getStats(), activeRuns: activeRuns.size };
    },

    async waitUntilReady(timeoutMs) {
      await workerManager.waitUntilReady(timeoutMs);
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

      await workerManager.shutdown();
    },
  };
}
