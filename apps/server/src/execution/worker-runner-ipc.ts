import {
  DispatchRuntime,
  type DispatchHandler,
  type DispatchToolRuntime,
  ToolProxyProvider,
} from "@openomni/openomni";
import { Tool } from "@openomni/protocol";

const WORKER_TOOL_CALL_IPC_TIMEOUT_MS = 5 * 60_000;
const WORKER_RESIDENT_ASK_IPC_TIMEOUT_MS = 5 * 60_000;

export interface WorkerRunIpcServer {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
}

export function createWorkerDispatchRuntime(options: {
  readonly server: WorkerRunIpcServer;
  readonly ipcAuthToken: string;
  readonly workerId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceRoot?: string;
}): DispatchToolRuntime {
  const runtime = new DispatchRuntime();
  const handler: DispatchHandler = async (command, context) => {
    if (!context?.wait) {
      throw new Error("worker dispatch resident.ask requires wait: true");
    }
    if (command.target.kind !== "resident") {
      throw new Error("worker dispatch resident.ask currently supports resident targets only");
    }

    const callId = command.dispatchId;
    const payload =
      typeof command.payload === "string" ? command.payload : JSON.stringify(command.payload);
    const sessionId = context.sessionId ?? options.sessionId;
    const runId = context.runId ?? options.runId;
    const workspaceRoot = context.workspaceRoot ?? options.workspaceRoot;
    const cancelInboundWait = () => {
      void options.server
        .call("worker.inbound_wait_cancel", { sessionId, runId, callId }, 5_000)
        .catch(() => undefined);
    };

    const raw = await abortableIpcCall(
      () =>
        options.server.call(
          "worker.inbound_wait",
          {
            authToken: options.ipcAuthToken,
            workerId: options.workerId,
            sessionId,
            runId,
            callId,
            payload,
            ...(workspaceRoot ? { workspaceRoot } : {}),
          },
          WORKER_RESIDENT_ASK_IPC_TIMEOUT_MS,
        ),
      context.signal,
      cancelInboundWait,
    );

    if (raw === null || typeof raw !== "object") {
      throw new Error("invalid worker.inbound_wait response");
    }
    const result = raw as { accepted?: unknown; output?: unknown; error?: unknown };
    if (result.accepted !== true) {
      throw new Error(
        typeof result.error === "string" ? result.error : "worker.inbound_wait rejected",
      );
    }

    return { output: typeof result.output === "string" ? result.output : "" };
  };

  runtime.register("resident.ask", handler);
  return {
    submit(input, context = {}) {
      return runtime.submit(input, {
        ...context,
        sessionId: context.sessionId ?? options.sessionId,
        runId: context.runId ?? options.runId,
        workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
        actorKind: context.actorKind ?? "worker",
        actorId: context.actorId ?? `${options.sessionId}:${options.runId}`,
        trustTier: context.trustTier ?? "assigned_worker",
        labels: [...(context.labels ?? []), "worker-runner"],
      });
    },
  };
}

export function createMcpProxyProvider(options: {
  readonly toolCatalog: Parameters<typeof ToolProxyProvider.create>[0];
  readonly server: WorkerRunIpcServer;
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceRoot?: string;
}): ReturnType<typeof ToolProxyProvider.create> {
  const { toolCatalog, server, runId, sessionId, workspaceRoot } = options;
  return ToolProxyProvider.create(toolCatalog, async (toolName, toolArgs, context) => {
    const callId = crypto.randomUUID();
    if (context?.signal?.aborted) {
      return {
        id: callId,
        toolCallId: callId,
        output: "Tool call aborted",
        isError: true,
      };
    }

    const cancelToolCall = () => {
      void server
        .call("worker.tool_call_cancel", { runId, sessionId, callId }, 5_000)
        .catch(() => undefined);
    };

    try {
      const raw = await abortableIpcCall(
        () =>
          server.call(
            "worker.tool_call",
            {
              runId,
              sessionId,
              callId,
              tool: toolName,
              input: toolArgs,
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
            WORKER_TOOL_CALL_IPC_TIMEOUT_MS,
          ),
        context?.signal,
        cancelToolCall,
      );
      return Tool.Result.parse(raw);
    } catch (error) {
      return {
        id: callId,
        toolCallId: callId,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
        settlement: "unknown",
      };
    }
  });
}

function createToolCallAbortError(): Error {
  const error = new Error("Tool call aborted");
  error.name = "AbortError";
  return error;
}

function abortableIpcCall<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(createToolCallAbortError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const handleAbort = () => {
      onAbort();
      finish(() => reject(createToolCallAbortError()));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
