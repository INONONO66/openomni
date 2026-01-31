import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createOpenAIProvider,
  OPENAI_MODELS,
  CODEX_ALLOWED_MODELS,
  getOpenAIModels,
} from "../../src/provider";

const mockFetch = mock(() =>
  Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
);

beforeEach(() => {
  mockFetch.mockClear();
  // @ts-expect-error - mock global fetch
  globalThis.fetch = mockFetch;
});

describe("createOpenAIProvider", () => {
  test("returns AI SDK provider with API key for api auth", () => {
    const result = createOpenAIProvider({ type: "api", key: "sk-xxx" });
    expect(result.provider).toBeDefined();
    expect(result.customFetch).toBeUndefined();
  });

  test("creates provider with custom fetch for oauth auth", () => {
    const result = createOpenAIProvider({
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
    });
    expect(result.provider).toBeDefined();
    expect(result.customFetch).toBeDefined();
  });

  test("custom fetch rewrites URL for /v1/responses path", async () => {
    const result = createOpenAIProvider({
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
    });

    await result.customFetch!("https://api.openai.com/v1/responses", {
      headers: {},
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });

  test("custom fetch rewrites URL for /chat/completions path", async () => {
    const result = createOpenAIProvider({
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
    });

    await result.customFetch!("https://api.openai.com/v1/chat/completions", {
      headers: {},
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });

  test("custom fetch injects Bearer token and removes dummy auth header", async () => {
    const result = createOpenAIProvider({
      type: "oauth",
      access: "my-access-token",
      refresh: "ref",
      expires: Date.now() + 60000,
    });

    await result.customFetch!("https://api.openai.com/v1/responses", {
      headers: { Authorization: "Bearer dummy-key" },
    });

    const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer my-access-token");
  });

  test("custom fetch adds ChatGPT-Account-Id header when accountId present", async () => {
    const result = createOpenAIProvider({
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60000,
      accountId: "acct-123",
    });

    await result.customFetch!("https://api.openai.com/v1/responses", {
      headers: {},
    });

    const [, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-123");
  });

  test("refreshes token when expired", async () => {
    const onTokenRefresh = mock(() => {});
    const refreshResponse = {
      access_token: "new-tok",
      refresh_token: "new-ref",
      id_token: "id",
      expires_in: 3600,
    };

    let fetchCallCount = 0;
    // @ts-expect-error - mock
    globalThis.fetch = mock((...args: any[]) => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return Promise.resolve(
          new Response(JSON.stringify(refreshResponse), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    const result = createOpenAIProvider(
      {
        type: "oauth",
        access: "expired-tok",
        refresh: "ref",
        expires: Date.now() - 1000,
      },
      onTokenRefresh,
    );

    await result.customFetch!("https://api.openai.com/v1/responses", {
      headers: {},
    });

    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(fetchCallCount).toBe(2);
  });

  test("concurrent requests share single token refresh (promise dedup)", async () => {
    let refreshCount = 0;
    const onTokenRefresh = mock(() => {});

    // @ts-expect-error - mock
    globalThis.fetch = mock((...args: any[]) => {
      const url =
        typeof args[0] === "string" ? args[0] : (args[0]?.toString?.() ?? "");
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
    });

    const result = createOpenAIProvider(
      {
        type: "oauth",
        access: "expired-tok",
        refresh: "ref",
        expires: Date.now() - 1000,
      },
      onTokenRefresh,
    );

    await Promise.all([
      result.customFetch!("https://api.openai.com/v1/responses", {
        headers: {},
      }),
      result.customFetch!("https://api.openai.com/v1/responses", {
        headers: {},
      }),
      result.customFetch!("https://api.openai.com/v1/responses", {
        headers: {},
      }),
    ]);

    expect(refreshCount).toBe(1);
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("getOpenAIModels", () => {
  test("returns hardcoded model list", () => {
    const models = getOpenAIModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.find((m) => m.id === "gpt-4o")).toBeDefined();
  });

  test("only allowed models visible in OAuth mode", () => {
    const models = getOpenAIModels("oauth");
    const modelIds = models.map((m) => m.id);
    for (const id of modelIds) {
      expect(CODEX_ALLOWED_MODELS).toContain(id);
    }
    expect(modelIds).toContain("gpt-5.1-codex-max");
    expect(modelIds).toContain("gpt-5.1-codex-mini");
  });
});
