import { describe, test, expect } from "bun:test";
import { createAnthropicOAuthFetch } from "../../src/fetch/anthropic";
import { createOpenAIOAuthFetch } from "../../src/fetch/openai";
import { getAuthProvider } from "../../src/auth/registry";
import { parseCallbackInput } from "../../src/oauth/callback-parser";
import type { Auth } from "../../src/auth/storage";

const noop = async (_info: Auth.Info) => {};

describe("fetch wrapper exports", () => {
  test("createAnthropicOAuthFetch is exported", () => {
    expect(typeof createAnthropicOAuthFetch).toBe("function");
  });

  test("createOpenAIOAuthFetch is exported", () => {
    expect(typeof createOpenAIOAuthFetch).toBe("function");
  });
});

describe("fetch wrapper factory", () => {
  test("createAnthropicOAuthFetch returns a fetch function", () => {
    const fetchFn = createAnthropicOAuthFetch({
      getAuth: async () => ({
        type: "oauth",
        access: "tok",
        refresh: "ref",
        expires: Date.now() + 3600_000,
      }),
      setAuth: noop,
    });
    expect(typeof fetchFn).toBe("function");
  });

  test("createOpenAIOAuthFetch returns a fetch function", () => {
    const fetchFn = createOpenAIOAuthFetch({
      getAuth: async () => ({
        type: "oauth",
        access: "tok",
        refresh: "ref",
        expires: Date.now() + 3600_000,
      }),
      setAuth: noop,
    });
    expect(typeof fetchFn).toBe("function");
  });
});

describe("fetch wrapper auth type guard", () => {
  test("createAnthropicOAuthFetch throws for non-oauth auth", async () => {
    const fetchFn = createAnthropicOAuthFetch({
      getAuth: async () => ({ type: "proxy", baseURL: "http://x", apiKey: "y" }),
      setAuth: noop,
    });
    await expect(fetchFn("https://api.anthropic.com/v1/messages")).rejects.toThrow("oauth");
  });

  test("createOpenAIOAuthFetch throws for non-oauth auth", async () => {
    const fetchFn = createOpenAIOAuthFetch({
      getAuth: async () => ({ type: "proxy", baseURL: "http://x", apiKey: "y" }),
      setAuth: noop,
    });
    await expect(fetchFn("https://api.openai.com/v1/responses")).rejects.toThrow("oauth");
  });

  test("createAnthropicOAuthFetch throws for api auth", async () => {
    const fetchFn = createAnthropicOAuthFetch({
      getAuth: async () => ({ type: "api", key: "sk-ant-xxx" }),
      setAuth: noop,
    });
    await expect(fetchFn("https://api.anthropic.com/v1/messages")).rejects.toThrow("oauth");
  });

  test("createOpenAIOAuthFetch throws for api auth", async () => {
    const fetchFn = createOpenAIOAuthFetch({
      getAuth: async () => ({ type: "api", key: "sk-xxx" }),
      setAuth: noop,
    });
    await expect(fetchFn("https://api.openai.com/v1/responses")).rejects.toThrow("oauth");
  });
});

describe("auth registry coexistence", () => {
  test("anthropic provider has 4 methods", () => {
    const provider = getAuthProvider("anthropic");
    expect(provider?.methods.length).toBe(4);
    const labels = provider?.methods.map((m) => m.label);
    expect(labels).toContain("Claude Pro/Max");
    expect(labels).toContain("CLIProxy");
    expect(labels).toContain("API key");
    expect(labels).toContain("Create an API Key");
  });

  test("openai provider has 4 methods", () => {
    const provider = getAuthProvider("openai");
    expect(provider?.methods.length).toBe(4);
    const labels = provider?.methods.map((m) => m.label);
    expect(labels).toContain("Browser");
    expect(labels).toContain("Device code");
    expect(labels).toContain("CLIProxy");
    expect(labels).toContain("API key");
  });

  test("all auth types represented across providers", () => {
    const anthropic = getAuthProvider("anthropic");
    const openai = getAuthProvider("openai");
    expect(anthropic).toBeDefined();
    expect(openai).toBeDefined();
    const allIds = [...anthropic!.methods, ...openai!.methods].map((m) => m.id);
    expect(allIds).toContain("oauth-max");
    expect(allIds).toContain("proxy");
    expect(allIds).toContain("api");
    expect(allIds).toContain("browser");
    expect(allIds).toContain("device");
  });
});

describe("callback parser", () => {
  test("parseCallbackInput handles full URL format", () => {
    expect(
      parseCallbackInput("https://platform.claude.com/oauth/code/callback?code=ABC&state=XYZ"),
    ).toEqual({ code: "ABC", state: "XYZ" });
  });

  test("parseCallbackInput handles hash format", () => {
    expect(parseCallbackInput("ABC#XYZ")).toEqual({ code: "ABC", state: "XYZ" });
  });

  test("parseCallbackInput handles query string format", () => {
    expect(parseCallbackInput("code=ABC&state=XYZ")).toEqual({ code: "ABC", state: "XYZ" });
  });

  test("parseCallbackInput returns null for invalid input", () => {
    expect(parseCallbackInput("invalid")).toBeNull();
    expect(parseCallbackInput("")).toBeNull();
  });
});
