import type { Auth } from "../auth";
import { CLIENT_ID, TOKEN_URL } from "../oauth/anthropic";
import {
  buildClaudeCodeHeaders,
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  type FetchInput,
} from "./anthropic-transform";

// Single Anthropic credential per process. Module-level singleton prevents
// concurrent refresh races — all factory invocations share this promise.
// Multi-profile support would require keying by refresh token.
let refreshPromise: Promise<string> | null = null;

export function createAnthropicOAuthFetch(options: {
  getAuth: () => Promise<Auth.Info>;
  setAuth: (info: Auth.Info) => Promise<void>;
}): typeof globalThis.fetch {
  const { getAuth, setAuth } = options;

  return async function oauthFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
    const auth = await getAuth();
    if (auth.type !== "oauth") {
      throw new Error('createAnthropicOAuthFetch: auth type must be "oauth"');
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

              const response = await fetch(TOKEN_URL, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/plain, */*",
                  "User-Agent": "axios/1.13.6",
                },
                body: JSON.stringify({
                  grant_type: "refresh_token",
                  refresh_token: auth.refresh,
                  client_id: CLIENT_ID,
                }),
              });

              if (!response.ok) {
                if (response.status >= 500 && attempt < maxRetries) {
                  await response.body?.cancel();
                  continue;
                }
                const body = await response.text().catch(() => "");
                throw new Error(`Token refresh failed: ${response.status} — ${body}`);
              }

              const json = (await response.json()) as {
                refresh_token: string;
                access_token: string;
                expires_in: number;
              };

              if (json.expires_in < 60) {
                throw new Error(
                  `Token refresh returned unreasonably short expiry: ${json.expires_in}s`,
                );
              }

              const nextAuth: Extract<Auth.Info, { type: "oauth" }> = {
                type: "oauth",
                access: json.access_token,
                refresh: json.refresh_token,
                expires: Date.now() + json.expires_in * 1000,
                ...(auth.accountId ? { accountId: auth.accountId } : {}),
              };

              await setAuth(nextAuth);
              return json.access_token;
            } catch (error: unknown) {
              const code =
                typeof error === "object" && error !== null && "code" in error
                  ? error.code
                  : undefined;
              const isNetworkError =
                error instanceof Error &&
                (error.message.includes("fetch failed") ||
                  code === "ECONNRESET" ||
                  code === "ECONNREFUSED" ||
                  code === "ETIMEDOUT" ||
                  code === "UND_ERR_CONNECT_TIMEOUT");

              if (attempt < maxRetries && isNetworkError) {
                continue;
              }

              throw error;
            }
          }

          throw new Error("Token refresh exhausted all retries");
        })().finally(() => {
          refreshPromise = null;
        });
      }

      auth.access = await refreshPromise;
    }

    const ccHeaders = buildClaudeCodeHeaders(auth.access);
    const requestHeaders = mergeHeaders(input, init);
    for (const [key, value] of Object.entries(ccHeaders)) {
      requestHeaders.set(key, value);
    }
    requestHeaders.delete("x-api-key");

    let body = init?.body;
    if (typeof body === "string") {
      body = rewriteRequestBody(body);
    } else if (body == null && input instanceof Request && input.body) {
      body = rewriteRequestBody(await input.clone().text());
    }

    const rewritten = rewriteUrl(input);

    const response = await fetch(rewritten.input, {
      ...init,
      body,
      headers: requestHeaders,
      ...(isInsecure() ? { tls: { rejectUnauthorized: false } } : {}),
    });

    return createStrippedStream(response);
  } as typeof globalThis.fetch;
}
