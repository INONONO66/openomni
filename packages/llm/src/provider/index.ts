import { z } from "zod";
import { Model as ProtocolModel } from "@openomni/protocol";
import { ProviderError } from "../error";
import { ModelsDev } from "../model";
import { Auth } from "../auth/storage";
import { fromModelsDevProvider } from "./sdk";
import { enrichWithCatalog, fetchProxyModels } from "./proxy-models";

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
    status: ProtocolModel.Status.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    release_date: z.string().optional(),
    variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  });
  export type Model = z.infer<typeof Model>;

  export const Info = z.object({
    id: z.string(),
    name: z.string(),
    source: z.enum(["env", "config", "custom", "api"]).optional(),
    env: z.array(z.string()),
    key: z.string().optional(),
    npm: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    models: z.record(z.string(), Model),
  });
  export type Info = z.infer<typeof Info>;

  export function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    return {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: model.cost
        ? {
            input: model.cost.input,
            output: model.cost.output,
            cache: {
              read: model.cost.cache_read ?? 0,
              write: model.cost.cache_write ?? 0,
            },
          }
        : undefined,
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

  export async function listModels(
    providerID: string,
    authType?: "proxy" | "api",
  ): Promise<Model[]> {
    const data = await ModelsDev.get();
    const provider = data[providerID];
    if (!provider) {
      throw new ProviderError({
        message: `Unknown provider: ${providerID}`,
        provider: providerID,
      });
    }
    const info = fromModelsDevProvider(provider);
    if (authType === "proxy") {
      const auth = await Auth.get(providerID);
      if (auth?.type === "proxy") {
        const proxyModelIds = await fetchProxyModels(auth.baseURL, auth.apiKey);
        if (proxyModelIds.length > 0) {
          return enrichWithCatalog(proxyModelIds, info.models, providerID);
        }
      }
    }

    return Object.values(info.models);
  }

  export async function listProviders(): Promise<string[]> {
    const data = await ModelsDev.get();
    return Object.keys(data);
  }

  export async function getProviderInfo(providerID: string): Promise<Info | undefined> {
    const data = await ModelsDev.get();
    const provider = data[providerID];
    if (!provider) return undefined;
    return fromModelsDevProvider(provider);
  }
}

export { ModelsDev } from "../model";
