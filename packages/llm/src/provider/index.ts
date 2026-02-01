import { z } from "zod";
import { ModelsDev } from "./models";

// Provider namespace with types and schemas
export namespace Provider {
  export const Model = z.object({
    id: z.string(),
    providerID: z.string(),
    api: z
      .object({
        id: z.string().optional(),
        url: z.string().optional(),
        npm: z.string(),
      })
      .optional(),
    name: z.string(),
    family: z.string().optional(),
    capabilities: z
      .object({
        temperature: z.boolean().optional(),
        reasoning: z.boolean().optional(),
        attachment: z.boolean().optional(),
        toolcall: z.boolean().optional(),
        input: z
          .object({
            text: z.boolean().optional(),
            audio: z.boolean().optional(),
            image: z.boolean().optional(),
            video: z.boolean().optional(),
            pdf: z.boolean().optional(),
          })
          .optional(),
        output: z
          .object({
            text: z.boolean().optional(),
            audio: z.boolean().optional(),
            image: z.boolean().optional(),
            video: z.boolean().optional(),
            pdf: z.boolean().optional(),
          })
          .optional(),
        interleaved: z
          .union([
            z.boolean(),
            z.object({
              field: z.enum(["reasoning_content", "reasoning_details"]),
            }),
          ])
          .optional(),
        vision: z.boolean().optional(),
        thinking: z.boolean().optional(),
        tools: z.boolean().optional(),
      })
      .optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cache: z
          .object({
            read: z.number().optional(),
            write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z
      .object({
        context: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
    status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
    options: z.record(z.string(), z.any()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    release_date: z.string().optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  });
  export type Model = z.infer<typeof Model>;

  export const Info = z.object({
    id: z.string(),
    name: z.string(),
    source: z.enum(["env", "config", "custom", "api"]).optional(),
    env: z.array(z.string()),
    key: z.string().optional(),
    npm: z.string().optional(),
    options: z.record(z.string(), z.any()).optional(),
    models: z.record(z.string(), Model),
  });
  export type Info = z.infer<typeof Info>;

  export function fromModelsDevModel(
    provider: ModelsDev.Provider,
    model: ModelsDev.Model,
  ): Model {
    return {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
      },
      limit: {
        context: model.limit?.context ?? 0,
        input: model.limit?.input,
        output: model.limit?.output ?? 0,
      },
      capabilities: {
        temperature: model.temperature ?? false,
        reasoning: model.reasoning ?? false,
        attachment: model.attachment ?? false,
        toolcall: model.tool_call ?? false,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date ?? "",
      variants: model.variants ?? {},
    };
  }
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
export { ProviderTransform } from "./transform";

// Re-export models
export { ModelsDev } from "./models";
