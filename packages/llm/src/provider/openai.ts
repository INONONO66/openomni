import type { OpenAIProviderSettings } from "@ai-sdk/openai";
import { createOpenAI } from "@ai-sdk/openai";
import { Auth } from "../auth/storage";
import { CODEX_API_ENDPOINT, refreshAccessToken } from "../auth/openai";
import type { Provider } from "./index";

type ProviderFetch = NonNullable<OpenAIProviderSettings["fetch"]>;

const OAUTH_DUMMY_KEY = "oauth-dummy-key";

export const CODEX_ALLOWED_MODELS = [
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const;

export const OPENAI_MODELS: Provider.Model[] = [
  {
    id: "gpt-4o",
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: false, tools: true },
    cost: { input: 2.5, output: 10 },
  },
  {
    id: "gpt-4o-mini",
    providerID: "openai",
    name: "GPT-4o Mini",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: false, tools: true },
    cost: { input: 0.15, output: 0.6 },
  },
  {
    id: "gpt-4.1",
    providerID: "openai",
    name: "GPT-4.1",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: false, tools: true },
    cost: { input: 2, output: 8 },
  },
  {
    id: "gpt-4.1-mini",
    providerID: "openai",
    name: "GPT-4.1 Mini",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: false, tools: true },
    cost: { input: 0.4, output: 1.6 },
  },
  {
    id: "gpt-4.1-nano",
    providerID: "openai",
    name: "GPT-4.1 Nano",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: false, tools: true },
    cost: { input: 0.1, output: 0.4 },
  },
  {
    id: "o3",
    providerID: "openai",
    name: "o3",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: true, tools: true },
    cost: { input: 10, output: 40 },
  },
  {
    id: "o3-mini",
    providerID: "openai",
    name: "o3-mini",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: false, thinking: true, tools: true },
    cost: { input: 1.1, output: 4.4 },
  },
  {
    id: "o4-mini",
    providerID: "openai",
    name: "o4-mini",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: true, tools: true },
    cost: { input: 1.1, output: 4.4 },
  },
  {
    id: "gpt-5.1-codex-max",
    providerID: "openai",
    name: "GPT-5.1 Codex Max",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: false, thinking: true, tools: true },
    cost: { input: 0, output: 0 },
  },
  {
    id: "gpt-5.1-codex-mini",
    providerID: "openai",
    name: "GPT-5.1 Codex Mini",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: false, thinking: true, tools: true },
    cost: { input: 0, output: 0 },
  },
  {
    id: "gpt-5.2",
    providerID: "openai",
    name: "GPT-5.2",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: true, thinking: true, tools: true },
    cost: { input: 0, output: 0 },
  },
  {
    id: "gpt-5.2-codex",
    providerID: "openai",
    name: "GPT-5.2 Codex",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: false, thinking: true, tools: true },
    cost: { input: 0, output: 0 },
  },
  {
    id: "gpt-5.1-codex",
    providerID: "openai",
    name: "GPT-5.1 Codex",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { vision: false, thinking: true, tools: true },
    cost: { input: 0, output: 0 },
  },
];

export function getOpenAIModels(mode?: "api" | "oauth"): Provider.Model[] {
  if (mode === "oauth") {
    const allowed = new Set<string>(CODEX_ALLOWED_MODELS);
    return OPENAI_MODELS.filter((m) => allowed.has(m.id));
  }
  return [...OPENAI_MODELS];
}

export async function getOpenAIModelsAsync(
  mode?: "api" | "oauth",
): Promise<Provider.Model[]> {
  let models: Provider.Model[] = [...OPENAI_MODELS];

  try {
    const { ModelsDev } = await import("./models");
    const providers = await ModelsDev.get();
    const openaiProvider = providers["openai"];

    if (openaiProvider?.models) {
      const devModels: Provider.Model[] = [];
      for (const [id, modelData] of Object.entries(openaiProvider.models)) {
        const isValidModel =
          typeof modelData === "object" && modelData !== null;
        const name =
          isValidModel &&
          "name" in modelData &&
          typeof modelData.name === "string"
            ? modelData.name
            : id;
        const cost =
          isValidModel &&
          "cost" in modelData &&
          typeof modelData.cost === "object" &&
          modelData.cost !== null
            ? modelData.cost
            : {};

        devModels.push({
          id,
          providerID: "openai",
          name,
          api: { npm: "@ai-sdk/openai" },
          capabilities: { vision: true, tools: true },
          cost: {
            input:
              "input" in cost && typeof cost.input === "number"
                ? cost.input
                : 0,
            output:
              "output" in cost && typeof cost.output === "number"
                ? cost.output
                : 0,
          },
        });
      }
      if (devModels.length > 0) {
        models = devModels;
      }
    }
  } catch {
    // Fall through to hardcoded fallback
  }

  if (mode === "oauth") {
    const allowed = new Set<string>(CODEX_ALLOWED_MODELS);
    return models.filter((m) => allowed.has(m.id));
  }

  return models;
}

type TokenRefreshCallback = (tokens: {
  access: string;
  refresh: string;
  expires: number;
}) => void;

export function createOpenAIProvider(
  auth: Auth.Info,
  onTokenRefresh?: TokenRefreshCallback,
): { provider: ReturnType<typeof createOpenAI>; customFetch?: ProviderFetch } {
  if (auth.type === "api") {
    return {
      provider: createOpenAI({ apiKey: auth.key }),
    };
  }

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
        onTokenRefresh?.({
          access: currentAccess,
          refresh: currentRefresh,
          expires: currentExpires,
        });
      } finally {
        refreshPromise = null;
      }
    })();

    await refreshPromise;
  }

  const customFetch = (async (
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
  }) as ProviderFetch;

  return {
    provider: createOpenAI({ apiKey: OAUTH_DUMMY_KEY, fetch: customFetch }),
    customFetch,
  };
}
