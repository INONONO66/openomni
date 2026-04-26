import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Auth } from "../auth/storage";
import { Provider } from "./index";
import type { ModelsDev } from "../model";

const BUNDLED_PROVIDERS: Record<string, (options: any) => any> = {
  "@ai-sdk/anthropic": createAnthropic,
  "@ai-sdk/openai": createOpenAI,
};

type SDK = ReturnType<typeof createAnthropic> | ReturnType<typeof createOpenAI>;

const SDK_CACHE = new Map<string, SDK>();
const LANGUAGE_CACHE = new Map<string, LanguageModel>();

type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => any;

interface CustomLoaderResult {
  getModel?: CustomModelLoader;
  options?: Record<string, any>;
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
    getModel(sdk: any, modelID: string) {
      return sdk.responses(modelID);
    },
    options: {},
  }),
};

export function getSDK(model: Provider.Model, auth: Auth.Info): any {
  const cacheKey = `${model.providerID}:${model.api?.npm ?? ""}:${JSON.stringify(auth)}`;
  const cached = SDK_CACHE.get(cacheKey);
  if (cached) return cached;

  const npm = model.api?.npm ?? "@ai-sdk/openai";
  const factory = BUNDLED_PROVIDERS[npm];

  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS[providerID];
  const custom = customLoader ? customLoader() : undefined;

  const sdkOptions: Record<string, any> = {
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
    const baseURL = model.api?.url ?? sdkOptions.baseURL;
    if (!baseURL) {
      throw new Error(`No bundled provider for npm package: ${npm} and no API URL available`);
    }
    const sdk = createOpenAICompatible({
      name: providerID,
      baseURL,
      apiKey: sdkOptions.apiKey,
    });
    SDK_CACHE.set(cacheKey, sdk as unknown as SDK);
    return sdk;
  }

  const sdk = factory(sdkOptions) as SDK;
  SDK_CACHE.set(cacheKey, sdk);
  return sdk;
}

export function getLanguage(model: Provider.Model, auth: Auth.Info): LanguageModel {
  const modelID = model.api?.id ?? model.id;
  const cacheKey = `${model.providerID}:${model.api?.npm ?? ""}:${modelID}:${JSON.stringify(auth)}`;
  const cached = LANGUAGE_CACHE.get(cacheKey);
  if (cached) return cached;

  const sdk = getSDK(model, auth);
  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS[providerID];
  const custom = customLoader ? customLoader() : undefined;

  if (custom?.getModel) {
    const languageModel = custom.getModel(sdk, modelID) as LanguageModel;
    LANGUAGE_CACHE.set(cacheKey, languageModel);
    return languageModel;
  }

  const languageModel = sdk.languageModel(modelID);
  LANGUAGE_CACHE.set(cacheKey, languageModel);
  return languageModel;
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

export const CODEX_ALLOWED_MODELS = new Set([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
]);

export function filterModels(
  providerID: string,
  authType: "api" | "proxy",
  models: Provider.Model[],
): Provider.Model[] {
  if (providerID === "openai" && authType === "proxy") {
    return models.filter((m) => CODEX_ALLOWED_MODELS.has(m.id));
  }
  return models;
}
