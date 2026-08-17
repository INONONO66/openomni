import { z } from "zod";
import { Model as ProtocolModel } from "@openomni/protocol";
import { ProviderError } from "../error";
import { ModelsDev } from "../model";
import { Auth } from "../auth/storage";
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
    limit: z
      .object({
        context: z.number(),
      })
      .optional(),
    status: ProtocolModel.Status.optional(),
    release_date: z.string().optional(),
  });
  export type Model = z.infer<typeof Model>;

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
      limit: {
        context: model.limit?.context ?? 0,
      },
      release_date: model.release_date ?? "",
    };
  }

  function catalogModels(provider: ModelsDev.Provider): Record<string, Model> {
    const models: Record<string, Model> = {};

    if (provider.models) {
      for (const [id, rawModel] of Object.entries(provider.models)) {
        const isValid = typeof rawModel === "object" && rawModel !== null;
        if (!isValid) continue;

        models[id] = fromModelsDevModel(provider, rawModel as ModelsDev.Model);
      }
    }

    return models;
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
    const models = catalogModels(provider);
    if (authType === "proxy") {
      const auth = await Auth.get(providerID);
      if (auth?.type === "proxy") {
        // fetchProxyModels throws ProxyModelsError on any listing failure —
        // never falls back to the full models.dev catalog, which would
        // present every model as "available on this proxy". An empty
        // (successful) listing is likewise honest: the proxy hosts nothing.
        const proxyModelIds = await fetchProxyModels(auth.baseURL, auth.apiKey);
        return enrichWithCatalog(proxyModelIds, models, providerID);
      }
    }

    return Object.values(models);
  }
}

export { ModelsDev } from "../model";
