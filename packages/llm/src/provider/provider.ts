import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import { Auth } from "../auth/storage";
import { createOAuthFetch } from "./oauth-fetch";
import { CODEX_API_ENDPOINT, refreshAccessToken } from "../auth/openai";
import { Provider } from "./index";
import { ModelsDev } from "./models";

const BUNDLED_PROVIDERS: Record<string, (options: any) => any> = {
  "@ai-sdk/anthropic": createAnthropic,
  "@ai-sdk/openai": createOpenAI,
};

type CustomModelLoader = (
  sdk: any,
  modelID: string,
  options?: Record<string, any>,
) => any;

interface CustomLoaderResult {
  getModel?: CustomModelLoader;
  options?: Record<string, any>;
}

const CUSTOM_LOADERS: Record<string, () => CustomLoaderResult> = {
  anthropic: () => ({
    options: {
      headers: {
        "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
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
  const npm = model.api?.npm ?? "@ai-sdk/openai";
  const factory = BUNDLED_PROVIDERS[npm];
  if (!factory) {
    throw new Error(`No bundled provider for npm package: ${npm}`);
  }

  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS[providerID];
  const custom = customLoader ? customLoader() : undefined;

  const sdkOptions: Record<string, any> = {
    ...(custom?.options ?? {}),
  };

  if (auth.type === "api") {
    sdkOptions.apiKey = auth.key;
  } else if (providerID === "anthropic") {
    const oauthFetch = createOAuthFetch(auth);
    sdkOptions.apiKey = "";
    sdkOptions.fetch = oauthFetch;
  } else if (providerID === "openai") {
    sdkOptions.apiKey = "oauth-dummy-key";
    sdkOptions.fetch = createOpenAIOAuthFetch(auth);
  }

  return factory(sdkOptions);
}

function createOpenAIOAuthFetch(
  auth: Extract<Auth.Info, { type: "oauth" }>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  let currentAccess = auth.access;
  let currentRefresh = auth.refresh;
  let currentExpires = auth.expires;
  const accountId = auth.accountId;
  let refreshPromise: Promise<void> | null = null;

  async function ensureValidToken() {
    if (currentAccess && currentExpires > Date.now()) return;
    if (refreshPromise) {
      await refreshPromise;
      return;
    }
    refreshPromise = (async () => {
      try {
        const tokens = await refreshAccessToken(currentRefresh);
        currentAccess = tokens.access_token;
        currentRefresh = tokens.refresh_token;
        currentExpires = Date.now() + (tokens.expires_in ?? 3600) * 1000;
      } finally {
        refreshPromise = null;
      }
    })();
    await refreshPromise;
  }

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.delete("authorization");
        init.headers.delete("Authorization");
      } else if (Array.isArray(init.headers)) {
        init.headers = init.headers.filter(
          ([key]) => key.toLowerCase() !== "authorization",
        );
      } else {
        delete (init.headers as Record<string, string>)["authorization"];
        delete (init.headers as Record<string, string>)["Authorization"];
      }
    }

    await ensureValidToken();

    const headers = new Headers();
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => headers.set(key, value));
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          if (value !== undefined) headers.set(key, String(value));
        }
      } else {
        for (const [key, value] of Object.entries(
          init.headers as Record<string, string>,
        )) {
          if (value !== undefined) headers.set(key, String(value));
        }
      }
    }

    headers.set("authorization", `Bearer ${currentAccess}`);
    if (accountId) {
      headers.set("ChatGPT-Account-Id", accountId);
    }

    const parsed =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : (input as Request).url);

    const url =
      parsed.pathname.includes("/v1/responses") ||
      parsed.pathname.includes("/chat/completions")
        ? new URL(CODEX_API_ENDPOINT)
        : parsed;

    return fetch(url, { ...init, headers });
  };
}

export function getLanguage(
  model: Provider.Model,
  auth: Auth.Info,
): LanguageModelV1 {
  const sdk = getSDK(model, auth);
  const providerID = model.providerID;
  const customLoader = CUSTOM_LOADERS[providerID];
  const custom = customLoader ? customLoader() : undefined;
  const modelID = model.api?.id ?? model.id;

  if (custom?.getModel) {
    return custom.getModel(sdk, modelID) as LanguageModelV1;
  }

  return sdk.languageModel(modelID);
}

export function fromModelsDevProvider(
  provider: ModelsDev.Provider,
): Provider.Info {
  const models: Record<string, Provider.Model> = {};

  if (provider.models) {
    for (const [id, rawModel] of Object.entries(provider.models)) {
      const isValid = typeof rawModel === "object" && rawModel !== null;
      if (!isValid) continue;

      models[id] = Provider.fromModelsDevModel(
        provider,
        rawModel as ModelsDev.Model,
      );
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
  authType: "api" | "oauth",
  models: Provider.Model[],
): Provider.Model[] {
  if (providerID === "openai" && authType === "oauth") {
    return models.filter((m) => CODEX_ALLOWED_MODELS.has(m.id));
  }
  return models;
}
