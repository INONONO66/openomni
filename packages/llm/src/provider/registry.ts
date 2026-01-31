import { Auth } from "../auth/storage";
import { ProviderError } from "../error";
import {
  createAnthropicProvider,
  getAnthropicModels,
  ANTHROPIC_MODELS,
} from "./anthropic";
import { Provider } from "./index";
import { createOpenAIProvider, getOpenAIModels, OPENAI_MODELS } from "./openai";

export type ProviderID = "anthropic" | "openai";

interface ProviderFactory {
  info: Provider.Info;
  create: (auth: Auth.Info, onTokenRefresh?: any) => any;
  models: Provider.Model[];
}

const PROVIDERS: Record<string, ProviderFactory> = {
  anthropic: {
    info: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: {},
    },
    create: createAnthropicProvider,
    models: ANTHROPIC_MODELS,
  },
  openai: {
    info: {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      models: {},
    },
    create: (auth, onRefresh?) =>
      createOpenAIProvider(auth, onRefresh).provider,
    models: OPENAI_MODELS,
  },
};

export function getProvider(providerID: string, auth: Auth.Info) {
  const entry = PROVIDERS[providerID];
  if (!entry)
    throw new ProviderError({
      message: `Unknown provider: ${providerID}`,
      provider: providerID,
    });
  return entry.create(auth);
}

export function listModels(
  providerID: string,
  authType?: "oauth" | "api",
): Provider.Model[] {
  const entry = PROVIDERS[providerID];
  if (!entry)
    throw new ProviderError({
      message: `Unknown provider: ${providerID}`,
      provider: providerID,
    });
  if (providerID === "openai" && authType === "oauth") {
    return getOpenAIModels("oauth");
  }
  return entry.models;
}

export function listProviders(): ProviderID[] {
  return Object.keys(PROVIDERS) as ProviderID[];
}

export function getProviderInfo(providerID: string): Provider.Info | undefined {
  return PROVIDERS[providerID]?.info;
}

// Keep listModelsAsync separate (it does dynamic imports)
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
