import { resolveDefaultProviderModel } from "../agents/model-resolution";
import type { ServerConfig } from "../config";

export async function resolveModel(config?: ServerConfig) {
  if (config?.model) {
    return { providerID: config.model.provider, id: config.model.id, name: config.model.id };
  }
  return resolveDefaultProviderModel();
}
