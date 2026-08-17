import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Auth } from "../auth/storage";
import type { Provider } from "./index";

type SdkOptions = {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};
type BundledProviderSDK = AnthropicProvider | OpenAIProvider;
type ProviderSDK = BundledProviderSDK;

// A Map keeps the lookup free of Object.prototype keys ("toString",
// "constructor", …) that an object literal would resolve via `in`/index
// access and invoke as SDK factories.
const BUNDLED_PROVIDERS = new Map<string, (options: SdkOptions) => BundledProviderSDK>([
  ["@ai-sdk/anthropic", (options) => createAnthropic(options)],
  ["@ai-sdk/openai", (options) => createOpenAI(options)],
]);

/**
 * What every path in this module actually produces. `LanguageModel` also
 * admits a bare gateway model id string, which nothing here returns — leaving
 * it in the signature only pushed casts onto callers.
 */
type ResolvedLanguageModel = Exclude<LanguageModel, string>;

const SDK_CACHE = new Map<string, ProviderSDK>();
const LANGUAGE_CACHE = new Map<string, ResolvedLanguageModel>();
const PROVIDER_SDK_CACHE_MAX_ENTRIES = 64;
const PROVIDER_LANGUAGE_CACHE_MAX_ENTRIES = 256;

type CustomModelLoader = (sdk: ProviderSDK, modelID: string) => ResolvedLanguageModel;

interface CustomLoaderResult {
  getModel?: CustomModelLoader;
  options?: Record<string, unknown>;
}

// A Map for the same reason as BUNDLED_PROVIDERS above: a plain Record
// resolves Object.prototype keys ("toString", "constructor", …) on index
// access and would invoke them as loaders.
const CUSTOM_LOADERS = new Map<string, () => CustomLoaderResult>([
  [
    "anthropic",
    () => ({
      options: {
        headers: {
          "anthropic-beta":
            "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        },
      },
    }),
  ],
  [
    "openai",
    () => ({
      getModel(sdk: ProviderSDK, modelID: string) {
        if (!isOpenAIProvider(sdk)) {
          throw new Error("OpenAI responses model loader requires responses support");
        }
        return sdk.responses(modelID);
      },
      options: {},
    }),
  ],
]);

// Auth material is hashed into cache keys so credentials never sit in Map
// keys (visible in heap dumps, debugger key listings, or accidental logs).
// SHA-256 (not a fast non-cryptographic hash): a key collision would hand
// one credential's cached SDK instance to a different credential.
function authFingerprint(auth: Auth.Info): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(auth)).digest("hex");
}

export function getSDK(model: Provider.Model, auth: Auth.Info): ProviderSDK {
  const cacheKey = `${model.providerID}:${model.api?.npm ?? ""}:${model.api?.url ?? ""}:${authFingerprint(auth)}`;
  const cached = getCached(SDK_CACHE, cacheKey);
  if (cached) return cached;

  const npm = model.api?.npm ?? "@ai-sdk/openai";
  const factory = BUNDLED_PROVIDERS.get(npm);

  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS.get(providerID);
  const custom = customLoader ? customLoader() : undefined;

  const sdkOptions: SdkOptions = {
    ...(custom?.options ?? {}),
  };
  // Honored for every provider, openai included: the old `!== "openai"` gate
  // silently ignored model.api.url for openai models and was carried in
  // without a recorded reason (#450). `name: "openai"` is the SDK default
  // there, so setting it is identity. Proxy auth still overrides below.
  if (model.api?.url) {
    sdkOptions.baseURL = model.api.url;
    sdkOptions.name = providerID;
  }

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
    const sdk = createOpenAI({
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

export function getLanguage(model: Provider.Model, auth: Auth.Info): ResolvedLanguageModel {
  const modelID = model.api?.id ?? model.id;
  const cacheKey = `${model.providerID}:${model.api?.npm ?? ""}:${model.api?.url ?? ""}:${modelID}:${authFingerprint(auth)}`;
  const cached = getCached(LANGUAGE_CACHE, cacheKey);
  if (cached) return cached;

  const sdk = getSDK(model, auth);
  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS.get(providerID);
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
): ResolvedLanguageModel {
  if (providerID === "openai" && auth.type === "proxy" && isOpenAIProvider(sdk)) {
    return sdk.chat(modelID);
  }
  if (custom?.getModel) {
    return custom.getModel(sdk, modelID);
  }
  return sdk.languageModel(modelID);
}

function isOpenAIProvider(sdk: ProviderSDK): sdk is OpenAIProvider {
  return "responses" in sdk;
}
