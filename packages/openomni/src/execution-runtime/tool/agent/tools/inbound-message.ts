import type { InboundMessage, Tool } from "@openomni/protocol";
import { InboundMessage as InboundMessageProtocol, Operational } from "@openomni/protocol";
import { Bus, WorkerRunStateStore } from "@openomni/session";
import { defineTool } from "../../define.js";
import type { NativeTool, ToolExecutionContext } from "../../types.js";

const MAX_DEPTH = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

type InboundMessageDispatchAction =
  | "resident.deliver"
  | "worker.spawn"
  | "worker.send"
  | "worker.resume"
  | "worker.cancel"
  | "schedule.create";

type InboundMessageDispatchCommand = {
  readonly action: InboundMessageDispatchAction;
  readonly target: InboundMessage.Target;
  readonly payload: string;
  readonly wait: boolean;
  readonly timeoutMs: number;
  readonly correlation: { readonly messageId: string };
};

type InboundMessageDispatchContext = {
  readonly signal?: AbortSignal;
  readonly wait: boolean;
  readonly timeoutMs: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
  readonly sourceTool: "inbound_message";
  readonly compatibility: {
    readonly messageId: string;
    readonly legacyAction?: InboundMessage.Input["action"];
    readonly depth: number;
    readonly injectToHistory: boolean;
    readonly schedule?: string;
  };
};

type InboundMessageDispatchResult = {
  readonly status?: string;
  readonly dispatchId?: string;
  readonly messageId?: string;
  readonly jobId?: string;
  readonly output?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly timedOut?: boolean;
  readonly result?: { readonly output?: unknown };
};

type InboundMessageDispatch = {
  submit(
    command: InboundMessageDispatchCommand,
    context: InboundMessageDispatchContext,
  ): Promise<InboundMessageDispatchResult>;
};

type InboundMessageRouter =
  | InboundMessageDispatch
  | { readonly dispatchRuntime?: InboundMessageDispatch };

type RuntimeInput = InboundMessage.Input & {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
};

const inputSchema = {
  type: "object",
  properties: {
    target: {
      type: "object",
      properties: {
        kind: { enum: ["resident", "worker"] },
        sessionId: { type: "string" },
        agentName: { type: "string" },
        parentSessionId: { type: "string" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    action: { enum: ["spawn", "send", "cancel", "resume", "schedule"] },
    payload: { type: "string" },
    wait: { type: "boolean", default: false },
    timeoutMs: { type: "number", default: DEFAULT_TIMEOUT_MS },
    injectToHistory: { type: "boolean", default: false },
    schedule: { type: "string" },
    depth: { type: "number", default: 0 },
  },
  required: ["target", "payload"],
  additionalProperties: false,
};

function toolResult(
  call: Tool.Call,
  output: InboundMessage.Result,
  isError?: boolean,
): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: JSON.stringify(output),
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(call: Tool.Call, message: string, messageId?: string): Tool.Result {
  return toolResult(
    call,
    {
      status: "error",
      ...(messageId ? { messageId } : {}),
      error: message,
    },
    true,
  );
}

function depthError(call: Tool.Call): Tool.Result {
  return toolResult(
    call,
    { status: "error", error: `depth limit exceeded: inbound_message maxDepth is ${MAX_DEPTH}` },
    true,
  );
}

function resolveRouter(router: InboundMessageRouter): {
  readonly dispatchRuntime?: InboundMessageDispatch;
} {
  if ("submit" in router) return { dispatchRuntime: router };
  return { dispatchRuntime: router.dispatchRuntime };
}

function dispatchActionFromInput(parsed: InboundMessage.Input): InboundMessageDispatchAction {
  if (parsed.action === "schedule") return "schedule.create";
  if (parsed.target.kind === "resident") return "resident.deliver";
  if (parsed.action === "cancel") return "worker.cancel";
  if (parsed.action === "resume") return "worker.resume";
  if (parsed.action === "send") return "worker.send";
  return parsed.target.sessionId ? "worker.send" : "worker.spawn";
}

function dispatchCommandFromInput(
  parsed: InboundMessage.Input,
  messageId: string,
): InboundMessageDispatchCommand {
  return {
    action: dispatchActionFromInput(parsed),
    target: parsed.target,
    payload: parsed.payload,
    wait: parsed.wait,
    timeoutMs: parsed.timeoutMs,
    correlation: { messageId },
  };
}

function dispatchContextFromInput(
  input: RuntimeInput,
  parsed: InboundMessage.Input,
  messageId: string,
  signal?: AbortSignal,
): InboundMessageDispatchContext {
  return {
    ...(signal ? { signal } : {}),
    wait: parsed.wait,
    timeoutMs: parsed.timeoutMs,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    sourceTool: "inbound_message",
    compatibility: {
      messageId,
      ...(parsed.action ? { legacyAction: parsed.action } : {}),
      depth: parsed.depth + 1,
      injectToHistory: parsed.injectToHistory,
      ...(parsed.schedule ? { schedule: parsed.schedule } : {}),
    },
  };
}

function dispatchOutput(result: InboundMessageDispatchResult): string | undefined {
  if (typeof result.output === "string") return result.output;
  const output = result.result?.output;
  if (typeof output === "string") return output;
  if (output !== undefined) return JSON.stringify(output);
  return undefined;
}

function dispatchMessageId(result: InboundMessageDispatchResult, fallback: string): string {
  return result.messageId ?? result.dispatchId ?? fallback;
}

function dispatchError(result: InboundMessageDispatchResult): string | undefined {
  return result.error ?? result.reason;
}

function isDispatchError(result: InboundMessageDispatchResult): boolean {
  return (
    result.status === "error" ||
    result.status === "failed" ||
    result.status === "denied" ||
    result.status === "pending"
  );
}

function publishAsyncDispatchFailure(
  result: InboundMessageDispatchResult,
  messageId: string,
  input: RuntimeInput,
): void {
  Bus.publish(Operational.Warn, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "inbound_message",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    msg: `async inbound_message dispatch ${result.status ?? "failed"}: ${dispatchError(result) ?? messageId}`,
  });
}

function resultFromDispatchDelivery(
  call: Tool.Call,
  messageId: string,
  result: InboundMessageDispatchResult,
): Tool.Result {
  if (isDispatchError(result)) {
    return toolResult(
      call,
      {
        status: "error",
        messageId: dispatchMessageId(result, messageId),
        ...(dispatchError(result) ? { error: dispatchError(result) } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
      },
      true,
    );
  }

  return toolResult(call, {
    status: "delivered",
    messageId: dispatchMessageId(result, messageId),
    output: dispatchOutput(result) ?? "",
  });
}

function resultFromDispatchSchedule(
  call: Tool.Call,
  messageId: string,
  result: InboundMessageDispatchResult,
): Tool.Result {
  if (isDispatchError(result)) {
    return toolResult(
      call,
      {
        status: "error",
        messageId: dispatchMessageId(result, messageId),
        ...(dispatchError(result) ? { error: dispatchError(result) } : {}),
      },
      true,
    );
  }

  const jobId = result.jobId ?? result.messageId ?? result.dispatchId ?? messageId;
  return toolResult(call, { status: "scheduled", messageId: jobId, jobId });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  messageId: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void = () => undefined;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    onAbort = () => rejectOnce(new AbortWaitError("inbound_message aborted", messageId));

    if (signal?.aborted) {
      reject(new AbortWaitError("inbound_message aborted", messageId));
      return;
    }

    const timer = globalThis.setTimeout(() => {
      rejectOnce(new TimeoutError(`inbound_message timed out after ${timeoutMs}ms`, messageId));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        resolveOnce(value);
      },
      (error: unknown) => {
        rejectOnce(error);
      },
    );
  });
}

class TimeoutError extends Error {
  constructor(
    message: string,
    readonly messageId: string,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

class AbortWaitError extends Error {
  constructor(
    message: string,
    readonly messageId: string,
  ) {
    super(message);
    this.name = "AbortError";
  }
}

function markRunWaiting(input: RuntimeInput): void {
  const { sessionId, runId } = input;
  if (!sessionId || !runId) return;

  try {
    const current = WorkerRunStateStore.get(sessionId, runId);
    if (current?.status === "starting") {
      WorkerRunStateStore.updateStatus(sessionId, runId, "running");
    }
    const running = WorkerRunStateStore.get(sessionId, runId);
    if (running?.status === "running") {
      WorkerRunStateStore.updateStatus(sessionId, runId, "waiting_input");
    }
  } catch {
    // WorkerRun state is best-effort for compatibility with non-worker test/tool contexts.
  }
}

function restoreRunRunning(input: RuntimeInput): void {
  const { sessionId, runId } = input;
  if (!sessionId || !runId) return;

  try {
    const current = WorkerRunStateStore.get(sessionId, runId);
    if (current?.status === "waiting_input") {
      WorkerRunStateStore.updateStatus(sessionId, runId, "running");
    }
  } catch {
    // WorkerRun state is best-effort for compatibility with non-worker test/tool contexts.
  }
}

export function createInboundMessageTool(router: InboundMessageRouter): NativeTool {
  const { dispatchRuntime } = resolveRouter(router);
  return defineTool<RuntimeInput>({
    name: "inbound_message",
    description: "Submit an internal inbound message to a resident or worker agent.",
    inputSchema,
    source: "agent",
    riskTier: 1,
    isReadOnly: false,
    isConcurrencySafe: true,
    implicitInputs: {
      sessionId: "sessionId",
      runId: "runId",
      agentName: "agentName",
      workspaceRoot: "workspaceRoot",
    },
    async execute(call, context?: ToolExecutionContext) {
      const input = call.input;
      const parsed = InboundMessageProtocol.Input.parse(input);
      if (parsed.depth >= MAX_DEPTH) return depthError(call);

      const messageId = crypto.randomUUID();
      const dispatchCommand = dispatchCommandFromInput(parsed, messageId);
      const dispatchContext = dispatchContextFromInput(input, parsed, messageId, context?.signal);

      if (!dispatchRuntime) {
        return errorResult(call, "inbound_message dispatch runtime is not configured", messageId);
      }

      if (parsed.action === "schedule") {
        try {
          const result = await dispatchRuntime.submit(dispatchCommand, dispatchContext);
          return resultFromDispatchSchedule(call, messageId, result);
        } catch (error) {
          return errorResult(
            call,
            error instanceof Error ? error.message : String(error),
            messageId,
          );
        }
      }

      if (!parsed.wait) {
        try {
          const submitted = dispatchRuntime.submit(dispatchCommand, dispatchContext);
          submitted
            .then((result) => {
              if (isDispatchError(result)) publishAsyncDispatchFailure(result, messageId, input);
            })
            .catch((error) => {
              publishAsyncDispatchFailure(
                {
                  status: "failed",
                  error: error instanceof Error ? error.message : String(error),
                },
                messageId,
                input,
              );
            });
        } catch (error) {
          return errorResult(
            call,
            error instanceof Error ? error.message : String(error),
            messageId,
          );
        }
        return toolResult(call, { status: "sent", messageId });
      }

      if (context?.signal?.aborted) {
        return errorResult(call, "inbound_message aborted", messageId);
      }

      markRunWaiting(input);
      try {
        const dispatchResult = await withTimeout(
          dispatchRuntime.submit(dispatchCommand, dispatchContext),
          parsed.timeoutMs,
          messageId,
          context?.signal,
        );
        return resultFromDispatchDelivery(call, messageId, dispatchResult);
      } catch (error) {
        if (error instanceof TimeoutError) {
          return toolResult(
            call,
            {
              status: "error",
              messageId: error.messageId,
              error: error.message,
              timedOut: true,
            },
            true,
          );
        }
        if (error instanceof AbortWaitError) {
          return errorResult(call, error.message, error.messageId);
        }
        return errorResult(call, error instanceof Error ? error.message : String(error), messageId);
      } finally {
        restoreRunRunning(input);
      }
    },
  });
}

export type { InboundMessageDispatch, InboundMessageRouter };
