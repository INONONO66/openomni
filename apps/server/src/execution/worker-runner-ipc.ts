import type { BoundarySanitizer } from "@openomni/llm/credential-runtime";
import {
  DispatchRuntime,
  type BoundWorkerKernelPortV1,
  type DispatchHandler,
  type DispatchToolRuntime,
  ToolProxyProvider,
} from "@openomni/openomni";
import { Execution, Tool } from "@openomni/protocol";

const WORKER_TOOL_CALL_IPC_TIMEOUT_MS = 5 * 60_000;
const WORKER_RESIDENT_ASK_IPC_TIMEOUT_MS = 5 * 60_000;
const WORKER_KERNEL_IPC_TIMEOUT_MS = 30_000;

function sanitizeIpcFailure(
  sanitizer: BoundarySanitizer,
  boundary: string,
  error: unknown,
): string {
  const message = sanitizer.sanitizeError(boundary, error).message;
  let bounded = "";
  let replacingControlCharacters = false;
  for (const character of message) {
    const characterCode = character.charCodeAt(0);
    if (characterCode <= 31 || characterCode === 127) {
      if (!replacingControlCharacters) bounded += " ";
      replacingControlCharacters = true;
      continue;
    }
    bounded += character;
    replacingControlCharacters = false;
    if (bounded.length >= 512) break;
  }
  return bounded.trim().slice(0, 512) || "unspecified";
}

export interface WorkerRunIpcServer {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
}

export function createWorkerKernelPort(options: {
  readonly server: WorkerRunIpcServer;
  readonly ipcAuthToken: string;
  readonly workerId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly runId: string;
}): BoundWorkerKernelPortV1 {
  const channel = {
    authToken: options.ipcAuthToken,
    workerId: options.workerId,
    generation: options.generation,
    sessionId: options.sessionId,
    runId: options.runId,
  };
  return Object.freeze({
    async execute(command: Parameters<BoundWorkerKernelPortV1["execute"]>[0]) {
      const raw = await options.server.call(
        "worker.kernel_transition",
        { ...channel, command },
        WORKER_KERNEL_IPC_TIMEOUT_MS,
      );
      return Execution.KernelTransitionResultV1.parse(raw);
    },
    async query(request: Parameters<BoundWorkerKernelPortV1["query"]>[0]) {
      const raw = await options.server.call(
        "worker.kernel_query",
        { ...channel, request },
        WORKER_KERNEL_IPC_TIMEOUT_MS,
      );
      return Execution.KernelQueryResultV1.parse(raw);
    },
  });
}

export function createWorkerDispatchRuntime(options: {
  readonly server: WorkerRunIpcServer;
  readonly ipcAuthToken: string;
  readonly workerId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceRoot?: string;
  readonly waitKernel: ConstructorParameters<typeof DispatchRuntime>[0]["waitKernel"];
  readonly authorityQueries: ConstructorParameters<typeof DispatchRuntime>[0]["authorityQueries"];
}): DispatchToolRuntime {
  const runtime = new DispatchRuntime({
    waitKernel: options.waitKernel,
    authorityQueries: options.authorityQueries,
  });
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
    if (context.sessionId !== undefined && context.sessionId !== options.sessionId) {
      throw new Error("worker dispatch session substitution denied");
    }
    if (context.runId !== undefined && context.runId !== options.runId) {
      throw new Error("worker dispatch run substitution denied");
    }
    if (context.workspaceRoot !== undefined && context.workspaceRoot !== options.workspaceRoot) {
      throw new Error("worker dispatch workspace substitution denied");
    }
    const sessionId = options.sessionId;
    const runId = options.runId;
    const cancelInboundWait = () => {
      void options.server
        .call(
          "worker.inbound_wait_cancel",
          {
            authToken: options.ipcAuthToken,
            workerId: options.workerId,
            generation: options.generation,
            sessionId,
            runId,
            callId,
          },
          5_000,
        )
        .catch(() => undefined);
    };

    const raw = await abortableIpcCall(
      () =>
        options.server.call(
          "worker.inbound_wait",
          {
            authToken: options.ipcAuthToken,
            workerId: options.workerId,
            generation: options.generation,
            sessionId,
            runId,
            callId,
            payload,
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
  readonly sanitizer: BoundarySanitizer;
  readonly server: WorkerRunIpcServer;
  readonly ipcAuthToken: string;
  readonly workerId: string;
  readonly generation: number;
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceRoot?: string;
}): ReturnType<typeof ToolProxyProvider.create> {
  const { toolCatalog, server, ipcAuthToken, workerId, generation, runId, sessionId, sanitizer } =
    options;
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
        .call(
          "worker.tool_call_cancel",
          { authToken: ipcAuthToken, workerId, generation, runId, sessionId, callId },
          5_000,
        )
        .catch(() => undefined);
    };

    try {
      const raw = await abortableIpcCall(
        () =>
          server.call(
            "worker.tool_call",
            {
              authToken: ipcAuthToken,
              workerId,
              generation,
              runId,
              sessionId,
              callId,
              tool: toolName,
              input: toolArgs,
            },
            WORKER_TOOL_CALL_IPC_TIMEOUT_MS,
          ),
        context?.signal,
        cancelToolCall,
      );
      const result = Tool.Result.parse(raw);
      if (result.isError !== true) return result;
      return {
        ...result,
        id: sanitizeIpcFailure(sanitizer, "worker-tool-result-id", result.id),
        toolCallId: sanitizeIpcFailure(sanitizer, "worker-tool-result-call-id", result.toolCallId),
        output: sanitizeIpcFailure(sanitizer, "worker-tool-result", result.output),
      };
    } catch (error) {
      return {
        id: callId,
        toolCallId: callId,
        output: sanitizeIpcFailure(sanitizer, "worker-tool-call", error),
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
