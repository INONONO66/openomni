import { z } from "zod";
import { ProviderError } from "../error";
import { ModelsDev } from "../model";
import { Auth } from "../auth/storage";
import { enrichWithCatalog, fetchProxyModels } from "./proxy-models";

export namespace Provider {
  /**
   * Only consumed catalog metadata lives here. `status` and `release_date`
   * were stored by the mapping below and read by nothing (#PR-2 slop pass) —
   * a field with no reader is a claim the code cannot keep, so it is gone
   * from the schema too: a re-add without a reader fails the mapping test.
   */
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
      limit: {
        context: model.limit?.context ?? 0,
      },
    };
  }

  function catalogModels(provider: ModelsDev.Provider): Record<string, Model> {
    const models: Record<string, Model> = {};

    for (const [id, rawModel] of Object.entries(provider.models)) {
      const isValid = typeof rawModel === "object" && rawModel !== null;
      if (!isValid) continue;

      models[id] = fromModelsDevModel(provider, rawModel as ModelsDev.Model);
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
