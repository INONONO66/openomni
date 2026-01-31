import { z } from "zod"

// Provider namespace with types and schemas
export namespace Provider {
  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    capabilities: z
      .object({
        vision: z.boolean(),
        thinking: z.boolean().optional(),
        tools: z.boolean(),
      })
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
      })
      .optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Info = z.object({
    id: z.string(),
    name: z.string(),
    models: z.record(z.string(), Model),
  })
  export type Info = z.infer<typeof Info>
}

// Re-export provider creation functions (standalone, NOT in namespace)
export { createAnthropicProvider, getAnthropicModels, ANTHROPIC_MODELS } from "./anthropic"
export { createOpenAIProvider, getOpenAIModels, OPENAI_MODELS, CODEX_ALLOWED_MODELS } from "./openai"

// Re-export registry functions
export { getProvider, listModels, listProviders, type ProviderID } from "./registry"
