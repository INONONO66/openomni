import type { AnthropicProviderSettings } from "@ai-sdk/anthropic";
import { createAnthropic } from "@ai-sdk/anthropic";
import { Auth } from "../auth/storage";
import { TokenRefreshError } from "../error";
import { Provider } from "./index";

type ProviderFetch = NonNullable<AnthropicProviderSettings["fetch"]>;

const REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44e8-ab96-aa70e6e435cb";
const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

export type TokenRefreshCallback = (
  access: string,
  refresh: string,
  expires: number,
) => void;

export function createOAuthFetch(
  auth: Extract<Auth.Info, { type: "oauth" }>,
  onTokenRefresh?: TokenRefreshCallback,
) {
  let currentAccess = auth.access;
  let currentRefresh = auth.refresh;
  let currentExpires = auth.expires;
  let pendingRefresh: Promise<void> | null = null;

  async function refreshToken() {
    const response = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: currentRefresh,
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok)
      throw new TokenRefreshError({
        message: `Token refresh failed: ${response.status}`,
        status: response.status,
      });
    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    currentAccess = json.access_token;
    currentRefresh = json.refresh_token;
    currentExpires = Date.now() + json.expires_in * 1000;
    onTokenRefresh?.(currentAccess, currentRefresh, currentExpires);
  }

  async function ensureValidToken() {
    if (currentAccess && currentExpires > Date.now()) return;
    if (!pendingRefresh) {
      pendingRefresh = refreshToken().finally(() => {
        pendingRefresh = null;
      });
    }
    await pendingRefresh;
  }

  return async function oauthFetch(
    input: string | Request | URL,
    init?: RequestInit,
  ) {
    await ensureValidToken();

    const requestHeaders = new Headers();
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => requestHeaders.set(k, v));
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) requestHeaders.set(k, String(v));
      } else {
        for (const [k, v] of Object.entries(h)) {
          if (v !== undefined) requestHeaders.set(k, String(v));
        }
      }
    }

    const incomingBetas = (requestHeaders.get("anthropic-beta") || "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    const mergedBetas = [
      ...new Set([...REQUIRED_BETAS, ...incomingBetas]),
    ].join(",");

    requestHeaders.set("authorization", `Bearer ${currentAccess}`);
    requestHeaders.set("anthropic-beta", mergedBetas);
    requestHeaders.delete("x-api-key");

    return fetch(input, { ...init, headers: requestHeaders });
  };
}

export const ANTHROPIC_MODELS: Provider.Model[] = [
  {
    id: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: { npm: "@ai-sdk/anthropic" },
    capabilities: { vision: true, thinking: true, tools: true },
    cost: { input: 3, output: 15 },
  },
  {
    id: "claude-opus-4-20250514",
    providerID: "anthropic",
    name: "Claude Opus 4",
    api: { npm: "@ai-sdk/anthropic" },
    capabilities: { vision: true, thinking: true, tools: true },
    cost: { input: 3, output: 15 },
  },
  {
    id: "claude-haiku-3-5-20241022",
    providerID: "anthropic",
    name: "Claude Haiku 3.5",
    api: { npm: "@ai-sdk/anthropic" },
    capabilities: { vision: true, thinking: false, tools: true },
    cost: { input: 0.25, output: 1.25 },
  },
];

export function getAnthropicModels(): Provider.Model[] {
  return ANTHROPIC_MODELS;
}

export async function getAnthropicModelsAsync(): Promise<Provider.Model[]> {
  try {
    const { ModelsDev } = await import("../models");
    const providers = await ModelsDev.get();
    const anthropicProvider = providers["anthropic"];

    if (anthropicProvider?.models) {
      const models: Provider.Model[] = [];
      for (const [id, modelData] of Object.entries(anthropicProvider.models)) {
        const isValidModel =
          typeof modelData === "object" && modelData !== null;
        const name =
          isValidModel &&
          "name" in modelData &&
          typeof modelData.name === "string"
            ? modelData.name
            : id;
        const capabilities =
          isValidModel &&
          "capabilities" in modelData &&
          typeof modelData.capabilities === "object" &&
          modelData.capabilities !== null
            ? modelData.capabilities
            : {};

        // Determine cost based on model ID
        let cost: { input: number; output: number };
        if (id.includes("haiku")) {
          cost = { input: 0.25, output: 1.25 };
        } else {
          cost = { input: 3, output: 15 };
        }

        models.push({
          id,
          providerID: "anthropic",
          name,
          api: { npm: "@ai-sdk/anthropic" },
          capabilities: {
            vision:
              "vision" in capabilities &&
              typeof capabilities.vision === "boolean"
                ? capabilities.vision
                : false,
            thinking:
              "thinking" in capabilities &&
              typeof capabilities.thinking === "boolean"
                ? capabilities.thinking
                : false,
            tools:
              "tools" in capabilities && typeof capabilities.tools === "boolean"
                ? capabilities.tools
                : false,
          },
          cost,
        });
      }
      if (models.length > 0) return models;
    }
  } catch {
    // Fall through to hardcoded fallback
  }

  return ANTHROPIC_MODELS;
}

export function createAnthropicProvider(
  auth: Auth.Info,
  onTokenRefresh?: TokenRefreshCallback,
) {
  if (auth.type === "api") {
    return createAnthropic({ apiKey: auth.key });
  }

  const customFetch = createOAuthFetch(auth, onTokenRefresh) as ProviderFetch;
  const provider = createAnthropic({ apiKey: "", fetch: customFetch });

  // Attach fetch to provider for runtime access by downstream consumers
  Object.assign(provider, { options: { fetch: customFetch } });
  return provider;
}
