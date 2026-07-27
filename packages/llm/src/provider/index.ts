import { createHash } from "node:crypto";
import { type Execution, Model as ProtocolModel } from "@openomni/protocol";
import { z } from "zod";
import { ProviderError } from "../error";
import type { ModelsDev, ModelCatalogProviderInput, ModelCatalogService } from "../model";
import { canonicalize } from "../model/catalog-cache";
import { fromModelsDevProvider } from "./sdk";

export namespace Provider {
  export const Model = z.object({
    id: z.string(),
    providerID: z.string(),
    api: z
      .object({ id: z.string().optional(), url: z.string().optional(), npm: z.string() })
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
            z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }),
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
        cache: z.object({ read: z.number().optional(), write: z.number().optional() }).optional(),
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

  /** Canonical identity digest for the complete validated runtime model. */
  export function modelDigest(model: Model): string {
    return createHash("sha256")
      .update(canonicalize(Model.parse(model)))
      .digest("hex");
  }

  /** Canonical identity digest for the complete redacted LLM environment base. */
  export function environmentDigest(
    environment: Omit<Execution.LLMEnvironmentV1, "environmentDigest">,
  ): string {
    return createHash("sha256").update(canonicalize(environment)).digest("hex");
  }

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

  export function fromModelsDevModel(
    provider: ModelCatalogProviderInput,
    model: ModelsDev.Model,
  ): Model {
    const npm = model.provider?.npm ?? provider.npm;
    if (!npm)
      throw new ProviderError({ message: "Model has no SDK package", provider: provider.id });
    return {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        ...("api" in provider && typeof provider.api === "string" ? { url: provider.api } : {}),
        npm,
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: model.cost
        ? {
            input: model.cost.input,
            output: model.cost.output,
            cache: { read: model.cost.cache_read ?? 0, write: model.cost.cache_write ?? 0 },
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
    catalog: ModelCatalogService,
    providerID: string,
  ): Promise<Model[]> {
    const provider = (await catalog.get())[providerID];
    if (!provider) {
      throw new ProviderError({ message: `Unknown provider: ${providerID}`, provider: providerID });
    }
    return Object.values(fromModelsDevProvider(provider).models);
  }

  export async function listProviders(catalog: ModelCatalogService): Promise<string[]> {
    return Object.keys(await catalog.get());
  }

  export async function getProviderInfo(
    catalog: ModelCatalogService,
    providerID: string,
  ): Promise<Info | undefined> {
    const provider = (await catalog.get())[providerID];
    return provider ? fromModelsDevProvider(provider) : undefined;
  }
}

export { ModelsDev, type ModelCatalogService } from "../model";
