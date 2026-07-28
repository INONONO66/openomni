import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { MaterializedCredential } from "../auth/secret-registry";
import type { ModelCatalogProviderInput, ModelsDev } from "../model";
import { Provider } from "./index";

type SdkOptions = {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};
type ProviderSDK = AnthropicProvider | OpenAIProvider;
type CustomModelLoader = (sdk: ProviderSDK, modelID: string) => LanguageModel;

interface CustomLoaderResult {
  getModel?: CustomModelLoader;
  options?: Record<string, unknown>;
}

const BUNDLED_PROVIDERS = {
  "@ai-sdk/anthropic": (options: SdkOptions) => createAnthropic(options),
  "@ai-sdk/openai": (options: SdkOptions) => createOpenAI(options),
} satisfies Record<string, (options: SdkOptions) => ProviderSDK>;

const CUSTOM_LOADERS: Record<string, () => CustomLoaderResult> = {
  anthropic: () => ({
    options: {
      headers: {
        "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      },
    },
  }),
  openai: () => ({
    getModel(sdk, modelID) {
      if (!isOpenAIProvider(sdk)) {
        throw new Error("OpenAI responses model loader requires responses support");
      }
      return sdk.responses(modelID);
    },
  }),
};

/**
 * Creates a provider SDK for one materialization scope. The returned SDK must
 * never be retained beyond the caller-owned callback because it contains a
 * decoded credential that JavaScript cannot zeroize.
 */
export function getSDK(model: Provider.Model, credential: MaterializedCredential): ProviderSDK {
  if (credential.providerId !== model.providerID) {
    throw new Error("Provider credential scope does not match the selected model");
  }
  const npm = model.api?.npm;
  if (!npm) throw new Error("Selected model does not declare an SDK package");

  const custom = CUSTOM_LOADERS[model.providerID]?.();
  const options: SdkOptions = { ...(custom?.options ?? {}) };
  const secret = credential.authType === "api" ? credential.key : credential.apiKey;
  if (secret !== undefined) options.apiKey = new TextDecoder().decode(secret);

  if (credential.authType === "proxy") {
    options.baseURL = credential.baseURL;
    options.apiKey ??= "proxy";
  } else if (model.api?.url && model.providerID !== "openai") {
    options.baseURL = model.api.url;
    options.name = model.providerID;
  }

  const factory = BUNDLED_PROVIDERS[npm as keyof typeof BUNDLED_PROVIDERS];
  if (factory) return factory(options);

  if (!options.baseURL) {
    throw new Error(`No bundled provider for SDK package: ${npm}`);
  }
  return createOpenAI({
    name: model.providerID,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
  });
}

export function getLanguage(
  model: Provider.Model,
  credential: MaterializedCredential,
): LanguageModel {
  const modelID = model.api?.id;
  if (!modelID) throw new Error("Selected model does not declare an SDK model identifier");
  const sdk = getSDK(model, credential);
  const custom = CUSTOM_LOADERS[model.providerID]?.();

  if (model.providerID === "openai" && credential.authType === "proxy" && isOpenAIProvider(sdk)) {
    return sdk.chat(modelID);
  }
  if (custom?.getModel) return custom.getModel(sdk, modelID);
  return sdk.languageModel(modelID);
}

function isOpenAIProvider(sdk: ProviderSDK): sdk is OpenAIProvider {
  return "responses" in sdk;
}

export function fromModelsDevProvider(provider: ModelCatalogProviderInput): Provider.Info {
  const models: Record<string, Provider.Model> = {};
  for (const [id, rawModel] of Object.entries(provider.models ?? {})) {
    if (typeof rawModel !== "object" || rawModel === null) continue;
    models[id] = Provider.fromModelsDevModel(provider, rawModel as ModelsDev.Model);
  }
  return {
    id: provider.id,
    name: provider.name,
    env: [...provider.env],
    npm: provider.npm,
    models,
  };
}
