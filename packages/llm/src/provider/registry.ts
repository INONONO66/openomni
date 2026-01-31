import { Auth } from "../auth/storage";
import { ProviderError } from "../error";
import { createAnthropicProvider, getAnthropicModels } from "./anthropic";
import { Provider } from "./index";
import { createOpenAIProvider, getOpenAIModels } from "./openai";

export type ProviderID = "anthropic" | "openai";

export function getProvider(providerID: string, auth: Auth.Info) {
  switch (providerID) {
    case "anthropic":
      return createAnthropicProvider(auth);
    case "openai":
      return createOpenAIProvider(auth).provider;
    default:
      throw new ProviderError({
        message: `Unknown provider: ${providerID}`,
        provider: providerID,
      });
  }
}

export function listModels(
  providerID: string,
  authType?: "oauth" | "api",
): Provider.Model[] {
  switch (providerID) {
    case "anthropic":
      return getAnthropicModels();
    case "openai":
      return getOpenAIModels(authType);
    default:
      throw new ProviderError({
        message: `Unknown provider: ${providerID}`,
        provider: providerID,
      });
  }
}

export async function listModelsAsync(
  providerID: string,
  authType?: "oauth" | "api",
): Promise<Provider.Model[]> {
  const { getAnthropicModelsAsync } = await import("./anthropic");
  const { getOpenAIModelsAsync } = await import("./openai");

  switch (providerID) {
    case "anthropic":
      return await getAnthropicModelsAsync();
    case "openai":
      return await getOpenAIModelsAsync(authType);
    default:
      throw new ProviderError({
        message: `Unknown provider: ${providerID}`,
        provider: providerID,
      });
  }
}

export function listProviders(): ProviderID[] {
  return ["anthropic", "openai"];
}
