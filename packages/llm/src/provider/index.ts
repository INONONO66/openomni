import { z } from "zod";

// Provider namespace with types and schemas
export namespace Provider {
  export const Model = z.object({
    id: z.string(),
    providerID: z.string(),
    name: z.string(),
    api: z.object({ npm: z.string() }).optional(),
    capabilities: z.object({
      vision: z.boolean(),
      thinking: z.boolean().optional(),
      tools: z.boolean(),
    }),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
      })
      .optional(),
  });
  export type Model = z.infer<typeof Model>;

  export const Info = z.object({
    id: z.string(),
    name: z.string(),
    npm: z.string(),
    env: z.array(z.string()),
    models: z.record(z.string(), Model),
  });
  export type Info = z.infer<typeof Info>;
}

// Re-export provider creation functions (standalone, NOT in namespace)
export {
  createAnthropicProvider,
  getAnthropicModels,
  getAnthropicModelsAsync,
  ANTHROPIC_MODELS,
} from "./anthropic";
export {
  createOpenAIProvider,
  getOpenAIModels,
  getOpenAIModelsAsync,
  OPENAI_MODELS,
  CODEX_ALLOWED_MODELS,
} from "./openai";

// Re-export registry functions
export {
  getProvider,
  listModels,
  listModelsAsync,
  listProviders,
  type ProviderID,
} from "./registry";

// Re-export transform utilities
export { ProviderTransform } from "../transform";
