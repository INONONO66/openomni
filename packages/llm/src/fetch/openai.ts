import type { OpenAIProviderSettings } from "@ai-sdk/openai";
import { Auth } from "../auth/storage";
import { CODEX_API_ENDPOINT, refreshAccessToken } from "../oauth/openai";

type ProviderFetch = NonNullable<OpenAIProviderSettings["fetch"]>;

const OAUTH_DUMMY_KEY = "oauth-dummy-key";

type TokenRefreshCallback = (tokens: { access: string; refresh: string; expires: number }) => void;

export function createCodexOAuthFetch(
  auth: Extract<Auth.Info, { type: "oauth" }>,
  onTokenRefresh?: TokenRefreshCallback,
): ProviderFetch {
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
        init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization");
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
        for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
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
      parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
        ? new URL(CODEX_API_ENDPOINT)
        : parsed;

    return fetch(url, { ...init, headers });
  }) as ProviderFetch;

  return customFetch;
}
