import { Provider, run as llmRun, type RunInput, type Sink } from "@openomni/llm";
import type { Message, Model } from "@openomni/protocol";
import { Bus, newTraceId, currentExecutor } from "@openomni/agent";
import { z } from "zod";
import { defineTool, ToolRefused } from "@openomni/agent";

/**
 * A one-shot sub-model call, without knowing how the host is composed: a
 * prompt in, the model's text out. Stateless by contract — each call is a
 * fresh completion, so the port carries no history.
 */
export type LlmPort = (prompt: string) => Promise<string>;

/** The per-cell call budget: how many sub-model calls one executor may serve. */
export const MAX_LLM_CALLS = 32;

const Input = z
  .object({
    prompts: z
      .array(z.string().min(1))
      .min(1)
      .describe("One or more complete instructions for stateless sub-model calls."),
  })
  .strict();

export const LLM_TOOL_NAME = "llm";

function executeLlm(llm: LlmPort) {
  let calls = 0;
  return async ({ prompts }: z.output<typeof Input>): Promise<string[]> => {
    if (calls + prompts.length > MAX_LLM_CALLS) {
      throw new ToolRefused(
        LLM_TOOL_NAME,
        `the per-cell budget of ${MAX_LLM_CALLS} sub-model calls is spent`,
      );
    }
    calls += prompts.length;
    return Promise.all(prompts.map((prompt) => llm(prompt)));
  };
}

export function createLlmTool(llm: LlmPort) {
  return defineTool({
    name: LLM_TOOL_NAME,
    category: "execution",
    description:
      "Ask a sub-model one or more one-shot, stateless questions. Results preserve prompt order.",
    input: Input,
    output: z.array(z.string()),
    visibility: { model: [], cell: ["resident", "worker"] },
    execute: executeLlm(llm),
    render: (_args, value) => JSON.stringify(value),
  });
}

/**
 * The same substitution seam ChatAgentConfig["llm"] gives the Resident and
 * the worker loop: absent fields use the real provider I/O. Boot passes its
 * `options.llm` through, so a composition booted on a fake model never lets
 * this one port slip out to the network.
 */
export interface LlmIo {
  readonly run?: typeof llmRun;
  readonly resolveModel?: (model: Model.Ref) => Promise<Provider.Model>;
}

/**
 * The llm tool's one-shot sub-model call: a single user message, no tools,
 * one step, its own synthesized trace — a nested run must never borrow the
 * turn's run identity. Auth is the configured key, exactly as the Resident
 * and the worker loop authenticate.
 */
interface ResolvedTextCall {
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly apiKey: string;
    readonly transport?: RunInput["transport"];
  };
  readonly messages: Message.WithParts[];
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly providerOptions?: Record<string, unknown>;
}

/** Shared resolved-model, credential, transport, and text-capture path for app-owned one-shot calls. */
export async function runResolvedText(call: ResolvedTextCall, io: LlmIo = {}): Promise<string> {
  let answer = "";
  const sink: Sink = {
    onMessage: (message) => {
      if (message.info.role !== "assistant") return;
      answer = message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
    },
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };
  const ref: Model.Ref = { provider: call.model.provider, id: call.model.id };
  const resolved = await (io.resolveModel ?? Provider.resolveModel)(ref);
  const input: RunInput = {
    messages: call.messages,
    tools: [],
    toolChoice: "none",
    maxSteps: 1,
    model: resolved,
    auth: { type: "api", key: call.model.apiKey },
    authProvider: call.model.provider,
    ...(call.model.transport === undefined ? {} : { transport: call.model.transport }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
    ...(call.providerOptions === undefined ? {} : { providerOptions: call.providerOptions }),
    trace: { traceId: newTraceId(), sessionId: call.sessionId, runId: crypto.randomUUID() },
    events: Bus,
  };
  const invoke = async () => {
    const outcome = await (io.run ?? llmRun)(input, sink);
    if (outcome.type === "stop") return { text: answer };
    if (outcome.type === "error") throw outcome.error;
    if (outcome.type === "aborted") throw new DOMException("sub-model aborted", "AbortError");
    throw new Error("sub-model returned continue");
  };
  const executor = currentExecutor();
  const runAttempts = executor.runAttempts;
  if (runAttempts === undefined) throw new Error("sub-model requires session attempt authority");
  const result = await executor.run(
    {
      kind: "llm",
      op: "text",
      intent: { provider: resolved.providerID, model: resolved.id },
      effect: {},
    },
    (parent) =>
      runAttempts(parent, {
        prepare: async (attempt) => ({
          request: {
            op: "text",
            intent: { attempt, provider: resolved.providerID, model: resolved.id },
            effect: {},
          },
          admit: async () => {
            call.signal?.throwIfAborted();
          },
          body: invoke,
        }),
      }),
  );
  if (result.terminal !== "executed") throw new Error(`sub-model refused: ${result.reason}`);
  const value = result.value;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.text !== "string"
  )
    throw new Error("invalid sub-model result");
  return value.text;
}

export function createLlmToolPort(model: ResolvedTextCall["model"], io: LlmIo = {}): LlmPort {
  return async (prompt) => {
    const sessionId = "llm-tool";
    const messageId = crypto.randomUUID();
    const request: Message.WithParts = {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "llm-tool",
        model: { providerID: model.provider, modelID: model.id },
      },
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text: prompt,
        },
      ],
    };
    return runResolvedText({ model, messages: [request], sessionId }, io);
  };
}
