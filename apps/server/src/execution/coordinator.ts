import { Execution, type Tool, type WorkerBootstrap } from "@openomni/protocol";
import {
  createWorkerManager,
  WorkerDeliveryError,
  type InboundWaitParams,
  type InboundWaitResult,
  type ToolCallContext,
  type WorkerManager,
} from "@openomni/coordinator";
import type { ToolExecutionContext, ToolProvider } from "@openomni/openomni";
import { Bus } from "@openomni/telemetry";
import { recoverInterruptedRuns as _recoverInterruptedRuns, type RecoveryResult } from "./recovery";

export type ToolDispatchHandler = (
  call: Tool.Call,
  context?: ToolExecutionContext,
) => Promise<Tool.Result>;

export type CoordinatorConfig = {
  workerScript: string;
  workerManagerFactory?: WorkerManagerFactory;
  maxWorkers?: number;
  workerIdleTimeoutMs?: number;
  socketDir?: string;
  bootstrap?: WorkerBootstrap.Bootstrap;
  toolDispatcher?: Map<string, ToolDispatchHandler>;
  askResident?: (params: InboundWaitParams) => Promise<InboundWaitResult>;
};

export type WorkerManagerFactory = typeof createWorkerManager;

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
  deliverMessage(
    sessionId: string,
    message: string,
    traceId: string,
    runId?: string,
  ): Promise<unknown>;
  getStats(): {
    workers: number;
    active: number;
    idle: number;
    ready: number;
    activeRuns: number;
    maxActiveWorkers: number;
  };
  waitUntilReady(timeoutMs?: number): Promise<void>;
  recoverInterruptedRuns(traceId: string): Promise<RecoveryResult>;
  shutdown(): Promise<void>;
};

export function createExecutionCoordinator(config: CoordinatorConfig): ExecutionCoordinator {
  const { toolDispatcher } = config;

  const workerManagerFactory = config.workerManagerFactory ?? createWorkerManager;
  const workerManager: WorkerManager = workerManagerFactory(
    {
      workerScript: config.workerScript,
      maxActiveWorkers: config.maxWorkers,
      idleShutdownMs: config.workerIdleTimeoutMs,
      socketDir: config.socketDir,
      bootstrap: config.bootstrap,
    },
    {
      // Composition-root binding: the driver's ledger event edge is the
      // session Bus today; P2 swaps this one binding when Ledger.append
      // splits from lossy Bus.publish (#462 §2).
      events: { publish: Bus.publish },
      inboundWait: config.askResident,
      toolRelay: toolDispatcher
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
                toolName: params.tool,
                output: `Unknown tool: ${params.tool}`,
                isError: true,
              };
            }
            const result = await handler(call, context);
            return {
              id: result.id,
              toolCallId: result.toolCallId,
              toolName: result.toolName ?? params.tool,
              output: result.output,
              isError: result.isError,
            };
          }
        : undefined,
    },
  );

  let isDraining = false;

  return {
    async dispatch(sessionTreeId, request) {
      if (isDraining) {
        throw new Error("Execution coordinator is draining");
      }

      // Slot affinity keys on task.sessionId. Every production dispatch site
      // passes sessionTreeId === request.sessionId; a caller that diverges
      // would silently shift slot affinity, so the invariant is enforced here.
      if (sessionTreeId !== request.sessionId) {
        throw new WorkerDeliveryError({
          message: `dispatch sessionTreeId ${sessionTreeId} does not match request.sessionId ${request.sessionId}`,
          code: "session_mismatch",
          runId: request.runId,
          sessionId: request.sessionId,
        });
      }
      const raw = await workerManager.deliver(request.runId, { ...request });
      return Execution.Result.parse(raw);
    },

    async cancelRun(runId) {
      return workerManager.cancel(runId);
    },

    async deliverMessage(sessionId, message, traceId, runId) {
      return workerManager.send(sessionId, message, traceId, runId);
    },

    getStats() {
      return workerManager.stats();
    },

    async waitUntilReady(timeoutMs) {
      await workerManager.waitUntilReady(timeoutMs);
    },

    async recoverInterruptedRuns(traceId: string) {
      return _recoverInterruptedRuns(traceId);
    },

    async shutdown() {
      isDraining = true;

      const deadline = Date.now() + 60_000;
      while (workerManager.stats().activeRuns > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }

      await workerManager.shutdown();
    },
  };
}
