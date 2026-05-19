import type { InboundMessage, Ingress, Tool } from "@openomni/protocol";
import { InboundMessage as InboundMessageProtocol } from "@openomni/protocol";
import { defineTool } from "../../define.js";
import type { NativeTool } from "../../types.js";

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, messageId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new TimeoutError(`inbound_message timed out after ${timeoutMs}ms`, messageId));
    }, timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
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
    async execute(call) {
      const input = call.input;
      const parsed = InboundMessageProtocol.Input.parse(input);
      if (parsed.depth > MAX_DEPTH) return depthError(call);

      const event = eventFromInput(input, parsed);
      const ingest = ingressEngine.ingest(event);

      if (!parsed.wait) {
        ingest.catch(() => undefined);
        return toolResult(call, { status: "sent", messageId: event.id });
      }

      try {
        const ingressResult = await withTimeout(ingest, parsed.timeoutMs, event.id);
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
        return errorResult(call, error instanceof Error ? error.message : String(error), event.id);
      }
    },
  });
}

export type { InboundMessageIngress };
