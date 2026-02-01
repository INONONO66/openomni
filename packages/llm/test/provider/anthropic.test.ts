import { describe, test, expect, mock, afterEach } from "bun:test";
import { getSDK, getLanguage, Provider } from "../../src/provider/index";
import { createOAuthFetch } from "../../src/fetch/anthropic";
import type { Auth } from "../../src/auth";

const originalFetch = globalThis.fetch;

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: { npm: "@ai-sdk/anthropic" },
    capabilities: { reasoning: true },
    cost: { input: 3, output: 15 },
    limit: { context: 200000, output: 16384 },
    ...overrides,
  };
}

describe("getSDK (Anthropic)", () => {
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

  test("oauth auth returns SDK with languageModel", () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
  });
});

describe("createOAuthFetch (Anthropic)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("injects Bearer token", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    };

    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const oauthFetch = createOAuthFetch(auth);
    await oauthFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(capturedHeaders?.get("authorization")).toBe("Bearer tok");
  });

  test("adds anthropic-beta header with required values", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    };

    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const oauthFetch = createOAuthFetch(auth);
    await oauthFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "anthropic-beta": "existing-beta-123" },
      body: JSON.stringify({}),
    });

    const beta = capturedHeaders?.get("anthropic-beta") ?? "";
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).toContain("interleaved-thinking-2025-05-14");
    expect(beta).toContain("existing-beta-123");
  });

  test("refreshes token when expired", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "expired-tok",
      refresh: "ref",
      expires: Date.now() - 1000,
    };

    let refreshCalled = false;
    let capturedAuthHeader: string | null = null;

    globalThis.fetch = mock(async (input: any, init: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("oauth/token")) {
        refreshCalled = true;
        return new Response(
          JSON.stringify({
            access_token: "new-tok",
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      capturedAuthHeader = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const onTokenRefresh = mock(
      (_access: string, _refresh: string, _expires: number) => {},
    );

    const oauthFetch = createOAuthFetch(auth, onTokenRefresh);
    await oauthFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(refreshCalled).toBe(true);
    expect(capturedAuthHeader).toBe("Bearer new-tok");
    expect(onTokenRefresh).toHaveBeenCalledWith(
      "new-tok",
      "new-ref",
      expect.any(Number),
    );
  });

  test("concurrent requests share single token refresh (promise dedup)", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "expired-tok",
      refresh: "ref",
      expires: Date.now() - 1000,
    };

    let refreshCount = 0;

    globalThis.fetch = mock(async (input: any, _init: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("oauth/token")) {
        refreshCount++;
        await new Promise((r) => setTimeout(r, 50));
        return new Response(
          JSON.stringify({
            access_token: "new-tok",
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const oauthFetch = createOAuthFetch(auth);

    await Promise.all([
      oauthFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "{}",
      }),
      oauthFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "{}",
      }),
      oauthFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "{}",
      }),
    ]);

    expect(refreshCount).toBe(1);
  });

  test("removes x-api-key header", async () => {
    const auth: Extract<Auth.Info, { type: "oauth" }> = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    };

    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const oauthFetch = createOAuthFetch(auth);
    await oauthFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "should-be-removed" },
    });

    expect(capturedHeaders?.get("x-api-key")).toBeNull();
  });
});

describe("getLanguage (Anthropic)", () => {
  test("returns a language model for anthropic model with api auth", () => {
    const auth: Auth.Info = { type: "api", key: "sk-xxx" };
    const model = getLanguage(makeModel(), auth);
    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("returns a language model for oauth auth", () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    };
    const model = getLanguage(makeModel(), auth);
    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("uses api.id when provided", () => {
    const auth: Auth.Info = { type: "api", key: "sk-xxx" };
    const model = getLanguage(
      makeModel({ api: { npm: "@ai-sdk/anthropic", id: "claude-3-haiku" } }),
      auth,
    );
    expect(model.modelId).toBe("claude-3-haiku");
  });
});
