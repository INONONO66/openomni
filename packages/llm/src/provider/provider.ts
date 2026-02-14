import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import { Auth } from "../auth/storage";
import { createOAuthFetch } from "../fetch/anthropic";
import { createCodexOAuthFetch } from "../fetch/openai";
import { Provider } from "./index";
import { ModelsDev } from "../model";

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
    const oauthAuth = auth as Extract<Auth.Info, { type: "oauth" }>;
    const oauthFetch = createOAuthFetch(
      oauthAuth,
      async (access, refresh, expires) => {
        await Auth.set(providerID, {
          type: "oauth",
          access,
          refresh,
          expires,
          ...(oauthAuth.accountId && { accountId: oauthAuth.accountId }),
        });
      },
    );
    sdkOptions.apiKey = "";
    sdkOptions.fetch = oauthFetch;
  } else if (providerID === "openai") {
    const oauthAuth = auth as Extract<Auth.Info, { type: "oauth" }>;
    sdkOptions.apiKey = "oauth-dummy-key";
    sdkOptions.fetch = createCodexOAuthFetch(oauthAuth, async (tokens) => {
      await Auth.set(providerID, {
        type: "oauth",
        access: tokens.access,
        refresh: tokens.refresh,
        expires: tokens.expires,
        ...(oauthAuth.accountId && { accountId: oauthAuth.accountId }),
      });
    });
  }

  return factory(sdkOptions);
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
