import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Auth } from "../auth/storage";
import { Provider } from "./index";
import type { ModelsDev } from "../model";

type SdkOptions = {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};

type ProviderSDK = {
  languageModel(modelID: string): unknown;
  chat?: (modelID: string) => unknown;
  responses?: (modelID: string) => unknown;
};

const BUNDLED_PROVIDERS: Record<string, (options: SdkOptions) => ProviderSDK> = {
  "@ai-sdk/anthropic": (options) => createAnthropic(options),
  "@ai-sdk/openai": (options) => createOpenAI(options),
};

const SDK_CACHE = new Map<string, ProviderSDK>();
const LANGUAGE_CACHE = new Map<string, LanguageModel>();
const PROVIDER_SDK_CACHE_MAX_ENTRIES = 64;
const PROVIDER_LANGUAGE_CACHE_MAX_ENTRIES = 256;

type CustomModelLoader = (
  sdk: ProviderSDK,
  modelID: string,
  options?: Record<string, unknown>,
) => LanguageModel;

interface CustomLoaderResult {
  getModel?: CustomModelLoader;
  options?: Record<string, unknown>;
}

const CUSTOM_LOADERS: Record<string, () => CustomLoaderResult> = {
  anthropic: () => ({
    options: {
      headers: {
        "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      },
    },
  }),
  openai: () => ({
    getModel(sdk: ProviderSDK, modelID: string) {
      if (!sdk.responses) {
        throw new Error("OpenAI responses model loader requires responses support");
      }
      return sdk.responses(modelID) as LanguageModel;
    },
    options: {},
  }),
};

export function getSDK(model: Provider.Model, auth: Auth.Info): ProviderSDK {
  const cacheKey = `${model.providerID}:${model.api?.npm ?? ""}:${JSON.stringify(auth)}`;
  const cached = getCached(SDK_CACHE, cacheKey);
  if (cached) return cached;

  const npm = model.api?.npm ?? "@ai-sdk/openai";
  const factory = BUNDLED_PROVIDERS[npm];

  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS[providerID];
  const custom = customLoader ? customLoader() : undefined;

  const sdkOptions: SdkOptions = {
    ...(custom?.options ?? {}),
  };

  if (auth.type === "api") {
    sdkOptions.apiKey = auth.key;
  } else if (auth.type === "proxy") {
    const proxyAuth = auth as Extract<Auth.Info, { type: "proxy" }>;
    if (proxyAuth.baseURL) sdkOptions.baseURL = proxyAuth.baseURL;
    sdkOptions.apiKey = proxyAuth.apiKey ?? "proxy";
  }

  if (!factory) {
    const baseURL = sdkOptions.baseURL ?? model.api?.url;
    if (!baseURL) {
      throw new Error(`No bundled provider for npm package: ${npm} and no API URL available`);
    }
    const sdk =
      auth.type === "proxy"
        ? createOpenAI({
            baseURL,
            apiKey: sdkOptions.apiKey,
          })
        : createOpenAICompatible({
            name: providerID,
            baseURL,
            apiKey: sdkOptions.apiKey,
          });
    setCached(SDK_CACHE, cacheKey, sdk, PROVIDER_SDK_CACHE_MAX_ENTRIES);
    return sdk;
  }

  const sdk = factory(sdkOptions);
  setCached(SDK_CACHE, cacheKey, sdk, PROVIDER_SDK_CACHE_MAX_ENTRIES);
  return sdk;
}

export function getLanguage(model: Provider.Model, auth: Auth.Info): LanguageModel {
  const modelID = model.api?.id ?? model.id;
  const cacheKey = `${model.providerID}:${model.api?.npm ?? ""}:${modelID}:${JSON.stringify(auth)}`;
  const cached = getCached(LANGUAGE_CACHE, cacheKey);
  if (cached) return cached;

  const sdk = getSDK(model, auth);
  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS[providerID];
  const custom = customLoader ? customLoader() : undefined;

  const languageModel = resolveLanguageModel(sdk, modelID, providerID, auth, custom);
  setCached(LANGUAGE_CACHE, cacheKey, languageModel, PROVIDER_LANGUAGE_CACHE_MAX_ENTRIES);
  return languageModel;
}

function getCached<T>(cache: Map<string, T>, key: string): T | undefined {
  const cached = cache.get(key);
  if (cached === undefined) return undefined;
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCached<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function resolveLanguageModel(
  sdk: ProviderSDK,
  modelID: string,
  providerID: string,
  auth: Auth.Info,
  custom: CustomLoaderResult | undefined,
): LanguageModel {
  if (providerID === "openai" && auth.type === "proxy" && sdk.chat) {
    return sdk.chat(modelID) as LanguageModel;
  }
  if (custom?.getModel) {
    return custom.getModel(sdk, modelID) as LanguageModel;
  }
  return sdk.languageModel(modelID) as LanguageModel;
}

export function fromModelsDevProvider(provider: ModelsDev.Provider): Provider.Info {
  const models: Record<string, Provider.Model> = {};

  if (provider.models) {
    for (const [id, rawModel] of Object.entries(provider.models)) {
      const isValid = typeof rawModel === "object" && rawModel !== null;
      if (!isValid) continue;

      models[id] = Provider.fromModelsDevModel(provider, rawModel as ModelsDev.Model);
    }
  }

  return {
    id: provider.id,
    name: provider.name,
    env: provider.env ?? [],
    npm: provider.npm,
    models,
  };
}

export function filterModels(
  providerID: string,
  authType: "api" | "proxy",
  models: Provider.Model[],
): Provider.Model[] {
  void providerID;
  void authType;
  return models;
}
