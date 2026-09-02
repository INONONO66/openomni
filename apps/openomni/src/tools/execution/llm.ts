import { ModelsDev, Provider, Run, run as llmRun, type RunInput, type Sink } from "@openomni/llm";
import type { Message, Model } from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/telemetry";
import { z } from "zod";
import { defineTool, ToolRefused } from "../core/define";

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
 * The llm tool's model, resolved from the models.dev catalog. Unlisted is an
 * ERROR, not a fallback: a bare model ref would drop the provider's `api.npm`
 * wiring and the LLM package would default to the OpenAI SDK — sending the
 * configured credential to the wrong provider. The agent loop's own resolver
 * refuses unlisted models for the same reason.
 */
/**
 * The same substitution seam ChatAgentConfig["llm"] gives the Resident and
 * the worker loop: absent fields use the real provider I/O. Boot passes its
 * `options.llm` through, so a composition booted on a fake model never lets
 * this one port slip out to the network.
 */
export interface LlmIo {
  readonly run?: typeof llmRun;
  readonly resolveProviderModel?: (model: Model.Ref) => Promise<Provider.Model>;
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
  const resolved =
    io.resolveProviderModel === undefined
      ? resolveLlmToolModel(await ModelsDev.get(), ref)
      : await io.resolveProviderModel(ref);
  const outcome = await (io.run ?? llmRun)(
    {
      messages: call.messages,
      tools: [],
      toolChoice: "none",
      maxSteps: 1,
      model: resolved,
      auth: { type: "api", key: call.model.apiKey },
      ...(call.model.transport === undefined ? {} : { transport: call.model.transport }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
      ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
      ...(call.providerOptions === undefined ? {} : { providerOptions: call.providerOptions }),
      trace: { traceId: newTraceId(), sessionId: call.sessionId, runId: crypto.randomUUID() },
      events: Bus,
    },
    sink,
  );
  if (outcome.type === "stop") return answer;
  if (outcome.type === "aborted") {
    const error = new Error("llm failed: the sub-model run ended as aborted", {
      ...(outcome.error === undefined ? {} : { cause: outcome.error }),
    });
    error.name = "AbortError";
    throw error;
  }
  if (outcome.type === "continue") {
    throw new Error("llm failed: the sub-model run ended as continue");
  }
  const reason = outcome.error.message;
  const failure: unknown = outcome.error;
  if (Run.FailureError.isInstance(failure)) throw failure;
  throw new Error(`llm failed: ${reason}`, { cause: failure });
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

export function resolveLlmToolModel(
  data: Record<string, ModelsDev.Provider>,
  model: { readonly provider: string; readonly id: string },
): Provider.Model {
  const provider = data[model.provider];
  const raw = provider?.models?.[model.id];
  if (provider === undefined || raw === undefined) {
    throw new Error(
      `llm failed: model "${model.id}" is not listed under provider "${model.provider}" in the models.dev catalog, so its SDK wiring is unknown`,
    );
  }
  return Provider.fromModelsDevModel(provider, raw as ModelsDev.Model);
}
