import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { getSDK, CODEX_ALLOWED_MODELS, Provider } from "../../src/provider/index";
import { createCodexOAuthFetch } from "../../src/fetch/openai";
import type { Auth } from "../../src/auth";

const originalFetch = globalThis.fetch;

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "gpt-4o",
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { reasoning: false },
    cost: { input: 2.5, output: 10 },
    ...overrides,
  };
}

const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));

describe("getSDK (OpenAI)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("api key auth returns SDK with languageModel", () => {
    const auth: Auth.Info = { type: "api", key: "sk-xxx" };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk).toBe("function");
    expect(typeof sdk.languageModel).toBe("function");
  });

  test("oauth auth returns SDK", () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
  });

  test("oauth auth with accountId returns SDK", () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
      accountId: "acct-123",
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
  });
});

describe("createCodexOAuthFetch (OpenAI)", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rewrites URL for /v1/responses path", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
    };

    const customFetch = createCodexOAuthFetch(auth);
    await customFetch("https://api.openai.com/v1/responses", {
      headers: {},
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  test("rewrites URL for /chat/completions path", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
    };

    const customFetch = createCodexOAuthFetch(auth);
    await customFetch("https://api.openai.com/v1/chat/completions", {
      headers: {},
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  test("injects Bearer token and removes dummy auth header", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "my-access-token",
      refresh: "ref",
      expires: Date.now() + 60000,
    };

    const customFetch = createCodexOAuthFetch(auth);
    await customFetch("https://api.openai.com/v1/responses", {
      headers: { Authorization: "Bearer dummy-key" },
    });

    const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer my-access-token");
  });

  test("adds ChatGPT-Account-Id header when accountId present", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
      accountId: "acct-123",
    };

    const customFetch = createCodexOAuthFetch(auth);
    await customFetch("https://api.openai.com/v1/responses", {
      headers: {},
    });

    const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-123");
  });

  test("refreshes token when expired", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = mock((..._args: any[]) => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "new-tok",
              refresh_token: "new-ref",
              id_token: "id",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as any;

    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "expired-tok",
      refresh: "ref",
      expires: Date.now() - 1000,
    };

    const onTokenRefresh = mock(() => {});
    const customFetch = createCodexOAuthFetch(auth, onTokenRefresh);
    await customFetch("https://api.openai.com/v1/responses", {
      headers: {},
    });

    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(fetchCallCount).toBe(2);
  });

  test("concurrent requests share single token refresh (promise dedup)", async () => {
    let refreshCount = 0;

    globalThis.fetch = mock((...args: any[]) => {
      const url = typeof args[0] === "string" ? args[0] : (args[0]?.toString?.() ?? "");
      if (typeof url === "string" && url.includes("/oauth/token")) {
        refreshCount++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "new-tok",
              refresh_token: "new-ref",
              id_token: "id",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as any;

    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "expired-tok",
      refresh: "ref",
      expires: Date.now() - 1000,
    };

    const customFetch = createCodexOAuthFetch(auth);

    await Promise.all([
      customFetch("https://api.openai.com/v1/responses", { headers: {} }),
      customFetch("https://api.openai.com/v1/responses", { headers: {} }),
      customFetch("https://api.openai.com/v1/responses", { headers: {} }),
    ]);

    expect(refreshCount).toBe(1);
  });

  test("does not rewrite non-API URLs", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
    };

    const customFetch = createCodexOAuthFetch(auth);
    await customFetch("https://api.openai.com/v1/models", {
      headers: {},
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.openai.com/v1/models");
  });
});

describe("CODEX_ALLOWED_MODELS", () => {
  test("is a Set containing expected codex models", () => {
    expect(CODEX_ALLOWED_MODELS).toBeInstanceOf(Set);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.1-codex-max")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.1-codex-mini")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.2")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.2-codex")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.1-codex")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-4o")).toBe(false);
  });
});
