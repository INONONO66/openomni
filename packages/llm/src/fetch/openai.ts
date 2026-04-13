import type { Auth } from "../auth";
import { TokenRefreshError } from "../error";
import { refreshAccessToken, CODEX_API_ENDPOINT } from "../oauth/openai";

let refreshPromise: Promise<string> | null = null;

export function createOpenAIOAuthFetch(options: {
  getAuth: () => Promise<Auth.Info>;
  setAuth: (info: Auth.Info) => Promise<void>;
}): typeof globalThis.fetch {
  const { getAuth, setAuth } = options;

  return async function oauthFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const auth = await getAuth();
    if (auth.type !== "oauth") {
      throw new Error('createOpenAIOAuthFetch: auth type must be "oauth"');
    }

    if (!auth.access || !auth.expires || auth.expires - 30_000 < Date.now()) {
      if (!refreshPromise) {
        refreshPromise = (async () => {
          const maxRetries = 2;
          const baseDelayMs = 500;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              if (attempt > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
                );
              }

              const tokens = await refreshAccessToken(auth.refresh);
              const expiresIn = tokens.expires_in ?? 3600;

              if (expiresIn < 60) {
                throw new Error(
                  `OpenAI token refresh returned unreasonably short expiry: ${expiresIn}s`,
                );
              }

              const nextAuth: Extract<Auth.Info, { type: "oauth" }> = {
                type: "oauth",
                access: tokens.access_token,
                refresh: tokens.refresh_token,
                expires: Date.now() + expiresIn * 1000,
                ...(auth.accountId ? { accountId: auth.accountId } : {}),
              };

              await setAuth(nextAuth);
              return tokens.access_token;
            } catch (error: unknown) {
              if (
                TokenRefreshError.isInstance(error) &&
                error.data.status >= 500 &&
                attempt < maxRetries
              ) {
                continue;
              }

              const code =
                typeof error === "object" && error !== null && "code" in error
                  ? (error as { code: unknown }).code
                  : undefined;
              const isNetworkError =
                error instanceof Error &&
                (error.message.includes("fetch failed") ||
                  code === "ECONNRESET" ||
                  code === "ECONNREFUSED" ||
                  code === "ETIMEDOUT" ||
                  code === "UND_ERR_CONNECT_TIMEOUT");

              if (attempt < maxRetries && isNetworkError) continue;
              throw error;
            }
          }

          throw new Error("OpenAI token refresh exhausted all retries");
        })().finally(() => {
          refreshPromise = null;
        });
      }

      auth.access = await refreshPromise;
    }

    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${auth.access}`);

    if (auth.accountId) {
      headers.set("ChatGPT-Account-Id", auth.accountId);
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
  } as typeof globalThis.fetch;
}
