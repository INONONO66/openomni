import { describe, test, expect, mock, beforeEach } from "bun:test";
import { authorize, exchange, refreshToken, createApiKey } from "../../src/oauth";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

describe("anthropic oauth", () => {
  test('authorize("max") returns url with correct OAuth params', async () => {
    const result = await authorize("max");
    const url = new URL(result.url);

    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe("org:create_api_key user:profile user:inference");
    expect(result.verifier).toBeTruthy();
    expect(typeof result.verifier).toBe("string");
  });

  test('authorize("console") uses console.anthropic.com domain', async () => {
    const result = await authorize("console");
    const url = new URL(result.url);

    expect(url.origin).toBe("https://console.anthropic.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  test("exchange(code, verifier) returns tokens on success", async () => {
    const mockTokens = {
      access_token: "acc_test123",
      refresh_token: "ref_test456",
      expires_in: 3600,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockTokens), { status: 200 })),
    ) as typeof fetch;

    const result = await exchange("mycode#mystate", "myverifier");

    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.access).toBe("acc_test123");
      expect(result.refresh).toBe("ref_test456");
      expect(result.expires).toBeGreaterThan(Date.now());
    }

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://console.anthropic.com/v1/oauth/token");
    const body = JSON.parse(call[1].body);
    expect(body.code).toBe("mycode");
    expect(body.state).toBe("mystate");
    expect(body.code_verifier).toBe("myverifier");
    expect(body.grant_type).toBe("authorization_code");
    expect(body.client_id).toBe(CLIENT_ID);

    globalThis.fetch = originalFetch;
  });

  test("exchange() returns failed on HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 400 })),
    ) as typeof fetch;

    const result = await exchange("bad#code", "verifier");
    expect(result).toEqual({ type: "failed" });

    globalThis.fetch = originalFetch;
  });

  test("refreshToken() calls refresh endpoint correctly", async () => {
    const mockTokens = {
      access_token: "new_acc",
      refresh_token: "new_ref",
      expires_in: 7200,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockTokens), { status: 200 })),
    ) as typeof fetch;

    const result = await refreshToken("old_refresh");

    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.access).toBe("new_acc");
      expect(result.refresh).toBe("new_ref");
    }

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://console.anthropic.com/v1/oauth/token");
    const body = JSON.parse(call[1].body);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("old_refresh");
    expect(body.client_id).toBe(CLIENT_ID);

    globalThis.fetch = originalFetch;
  });

  test("createApiKey() calls API key creation endpoint", async () => {
    const mockResponse = { raw_key: "sk-ant-test-key" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 })),
    ) as typeof fetch;

    const result = await createApiKey("my_access_token");

    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.key).toBe("sk-ant-test-key");
    }

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.anthropic.com/api/oauth/claude_cli/create_api_key");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["authorization"]).toBe("Bearer my_access_token");

    globalThis.fetch = originalFetch;
  });
});
