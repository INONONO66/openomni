import type { InboundMessage, Ingress, Tool } from "@openomni/protocol";
import { InboundMessage as InboundMessageProtocol } from "@openomni/protocol";
import { WorkerRunStateStore } from "@openomni/session";
import { defineTool } from "../../define.js";
import type { NativeTool, ToolExecutionContext } from "../../types.js";

const MAX_DEPTH = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

type InboundMessageIngress = {
  ingest(event: Ingress.InboundEvent): Promise<Ingress.IngressResult>;
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
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: `depth limit exceeded: inbound_message maxDepth is ${MAX_DEPTH}`,
    isError: true,
  };
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

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  messageId: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const cleanup = () => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
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

    timer = globalThis.setTimeout(() => {
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

export function createInboundMessageTool(ingressEngine: InboundMessageIngress): NativeTool {
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

      const event = eventFromInput(input, parsed);

      if (!parsed.wait) {
        const ingest = ingressEngine.ingest(event);
        ingest.catch(() => undefined);
        return toolResult(call, { status: "sent", messageId: event.id });
      }

      if (context?.signal?.aborted) {
        return errorResult(call, "inbound_message aborted", event.id);
      }

      markRunWaiting(input);
      try {
        const ingressResult = await withTimeout(
          ingressEngine.ingest(event),
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

export type { InboundMessageIngress };
