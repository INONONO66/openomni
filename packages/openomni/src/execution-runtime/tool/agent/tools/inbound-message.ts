import type { InboundMessage, Ingress, Tool } from "@openomni/protocol";
import { CronJob, InboundMessage as InboundMessageProtocol } from "@openomni/protocol";
import { WorkerRunStateStore } from "@openomni/session";
import { CronJobRegistry } from "../../../cron-job-registry.js";
import { defineTool } from "../../define.js";
import type { NativeTool, ToolExecutionContext } from "../../types.js";

const MAX_DEPTH = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

type InboundMessageIngress = {
  ingest(
    event: Ingress.InboundEvent,
    options?: { readonly signal?: AbortSignal; readonly wait?: boolean },
  ): Promise<Ingress.IngressResult>;
};

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
  | InboundMessageIngress
  | InboundMessageDispatch
  | {
      readonly ingressEngine?: InboundMessageIngress;
      readonly dispatchRuntime?: InboundMessageDispatch;
    };

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
  readonly ingressEngine?: InboundMessageIngress;
  readonly dispatchRuntime?: InboundMessageDispatch;
} {
  if ("ingest" in router) return { ingressEngine: router };
  if ("submit" in router) return { dispatchRuntime: router };
  return { ingressEngine: router.ingressEngine, dispatchRuntime: router.dispatchRuntime };
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

function resultFromDispatchDelivery(
  call: Tool.Call,
  messageId: string,
  result: InboundMessageDispatchResult,
): Tool.Result {
  if (result.status === "error" || result.status === "failed") {
    return toolResult(
      call,
      {
        status: "error",
        messageId: dispatchMessageId(result, messageId),
        ...(result.error ? { error: result.error } : {}),
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
  if (result.status === "error" || result.status === "failed") {
    return toolResult(
      call,
      {
        status: "error",
        messageId: dispatchMessageId(result, messageId),
        ...(result.error ? { error: result.error } : {}),
      },
      true,
    );
  }

  const jobId = result.jobId ?? result.messageId ?? result.dispatchId ?? messageId;
  return toolResult(call, { status: "scheduled", messageId: jobId, jobId });
}

function actorFromInput(input: RuntimeInput): Ingress.ActorMetadata {
  return {
    kind: "agent",
    role: input.agentName,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

function eventFromInput(input: RuntimeInput, parsed: InboundMessage.Input): Ingress.InboundEvent {
  const target = parsed.target as Ingress.Target;
  return {
    id: crypto.randomUUID(),
    surface: "internal",
    ...(input.workspaceRoot ? { workspace: input.workspaceRoot } : {}),
    mode: "direct",
    target,
    payload: parsed.payload,
    meta: {
      actor: actorFromInput(input),
      target,
      ...(parsed.action ? { action: parsed.action } : {}),
      depth: parsed.depth + 1,
      ...(parsed.injectToHistory ? { injectToHistory: true } : {}),
      ...(parsed.schedule ? { schedule: parsed.schedule } : {}),
      ...(parsed.target.agentName ? { agentName: parsed.target.agentName } : {}),
    },
    agent: {
      model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
    },
  };
}

function scheduleJobFromInput(input: RuntimeInput, parsed: InboundMessage.Input): CronJob.Info {
  const agentName = parsed.target.agentName ?? input.agentName;
  if (!agentName) {
    throw new Error("target.agentName is required when action is schedule");
  }

  return CronJob.Info.parse({
    id: crypto.randomUUID(),
    agentName,
    payload: parsed.payload,
    schedule: parsed.schedule,
    target: {
      kind: parsed.target.kind,
      ...(parsed.target.sessionId ? { sessionId: parsed.target.sessionId } : {}),
    },
    createdAt: Date.now(),
  });
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
  const { ingressEngine, dispatchRuntime } = resolveRouter(router);
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

      if (parsed.action === "schedule") {
        if (dispatchRuntime) {
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

        try {
          const jobId = CronJobRegistry.register(scheduleJobFromInput(input, parsed));
          return toolResult(call, { status: "scheduled", messageId: jobId, jobId });
        } catch (error) {
          return errorResult(call, error instanceof Error ? error.message : String(error));
        }
      }

      if (dispatchRuntime) {
        if (!parsed.wait) {
          try {
            const submitted = dispatchRuntime.submit(dispatchCommand, dispatchContext);
            submitted.catch(() => undefined);
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
          return errorResult(
            call,
            error instanceof Error ? error.message : String(error),
            messageId,
          );
        } finally {
          restoreRunRunning(input);
        }
      }

      if (!ingressEngine)
        return errorResult(call, "inbound_message dispatch runtime is not configured", messageId);

      const event = eventFromInput(input, parsed);

      if (!parsed.wait) {
        try {
          const ingest = ingressEngine.ingest(event, { wait: false });
          ingest.catch(() => undefined);
        } catch (error) {
          return errorResult(
            call,
            error instanceof Error ? error.message : String(error),
            event.id,
          );
        }
        return toolResult(call, { status: "sent", messageId: event.id });
      }

      if (context?.signal?.aborted) {
        return errorResult(call, "inbound_message aborted", event.id);
      }

      markRunWaiting(input);
      try {
        const ingressResult = await withTimeout(
          ingressEngine.ingest(event, { signal: context?.signal, wait: true }),
          parsed.timeoutMs,
          event.id,
          context?.signal,
        );
        return toolResult(call, {
          status: "delivered",
          messageId: event.id,
          output: ingressResult.result.output,
        });
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
        return errorResult(call, error instanceof Error ? error.message : String(error), event.id);
      } finally {
        restoreRunRunning(input);
      }
    },
  });
}

export type { InboundMessageDispatch, InboundMessageIngress, InboundMessageRouter };
