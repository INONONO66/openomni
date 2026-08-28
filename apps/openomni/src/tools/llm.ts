import { type ModelsDev, Provider } from "@openomni/llm";
import type { Tool } from "@openomni/protocol";
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
