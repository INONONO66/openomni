import { ModelsDev, Provider, run as llmRun, type RunInput, type Sink } from "@openomni/llm";
import type { Message, Model, Tool } from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/telemetry";
import { z } from "zod";

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
    prompt: z.string().min(1).describe("The complete instruction for the sub-model call."),
  })
  .strict();

export const LLM_TOOL_NAME = "llm";

/**
 * Hand-written for the same reason the delegate tool's is: zod 3 ships no
 * JSON Schema conversion. The zod object above stays the runtime gate.
 */
const INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description: "The complete instruction for the sub-model call.",
    },
  },
};

export function llmToolSpec(): Tool.Spec {
  return {
    name: LLM_TOOL_NAME,
    description:
      "Ask a sub-model a one-shot, stateless question and get its text back. Built for semantic map/reduce over data already inside a cell: summarize, classify, extract, or rank what the code fetched, one prompt per call — it remembers nothing between calls.",
    inputSchema: INPUT_JSON_SCHEMA,
    safe: true,
    placement: "host",
  };
}

export function llmToolExecutor(llm: LlmPort) {
  // catalogEntries() builds fresh executors per catalog construction — per
  // cell, per turn — so this counter IS the per-cell budget: a cell that
  // spends it gets refusals, and the next cell starts at zero.
  //
  // Refusals and failures THROW rather than return: this tool's consumer is
  // code, not the model, and code treats any returned string as model output.
  // The dispatcher turns the throw into an error result, which the cell door
  // raises as a catchable ToolError.
  let calls = 0;
  return async (rawInput: unknown): Promise<string> => {
    const parsed = Input.safeParse(rawInput);
    if (!parsed.success) {
      throw new Error(`llm refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`);
    }
    if (calls >= MAX_LLM_CALLS) {
      throw new Error(`llm refused: the per-cell budget of ${MAX_LLM_CALLS} sub-model calls is spent`);
    }
    calls += 1;
    return llm(parsed.data.prompt);
  };
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
export function createLlmToolPort(
  model: {
    readonly provider: string;
    readonly id: string;
    readonly apiKey: string;
    /** Operator transport config, resolved by the host (`modelTransport`). */
    readonly transport?: RunInput["transport"];
  },
  io: LlmIo = {},
): LlmPort {
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
    const ref: Model.Ref = { provider: model.provider, id: model.id };
    const resolved =
      io.resolveProviderModel === undefined
        ? resolveLlmToolModel(await ModelsDev.get(), ref)
        : await io.resolveProviderModel(ref);
    const outcome = await (io.run ?? llmRun)(
      {
        messages: [request],
        tools: [],
        maxSteps: 1,
        model: resolved,
        auth: { type: "api", key: model.apiKey },
        ...(model.transport === undefined ? {} : { transport: model.transport }),
        trace: {
          traceId: newTraceId(),
          sessionId,
          runId: crypto.randomUUID(),
        },
        events: Bus,
      },
      sink,
    );
    if (outcome.type !== "stop") {
      const reason =
        "error" in outcome && outcome.error !== undefined
          ? outcome.error.message
          : `the sub-model run ended as ${outcome.type}`;
      // Thrown, not returned: the consumer is cell code, and a failure string
      // returned as data would be stored as if it were model output.
      throw new Error(`llm failed: ${reason}`);
    }
    return answer;
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
