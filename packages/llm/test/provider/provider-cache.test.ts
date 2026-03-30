import { describe, expect, test } from "bun:test";
import type { Auth } from "../../src/auth";
import { getLanguage, getSDK, type Provider } from "../../src/provider/index";

function makeAnthropicModel(id = "claude-sonnet-4-20250514"): Provider.Model {
  return {
    id,
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: { npm: "@ai-sdk/anthropic" },
    capabilities: { reasoning: true },
    cost: { input: 3, output: 15 },
  };
}

function makeOpenAIModel(id = "gpt-4o"): Provider.Model {
  return {
    id,
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { reasoning: false },
    cost: { input: 2.5, output: 10 },
  };
}

describe("provider caches", () => {
  test("reuses SDK for the same provider and auth", () => {
    const auth: Auth.Info = { type: "api", key: "sk-test" };

    const first = getSDK(makeAnthropicModel(), auth);
    const second = getSDK(makeAnthropicModel(), auth);

    expect(first).toBe(second);
  });

  test("reuses SDK across models when provider and auth are the same", () => {
    const auth: Auth.Info = { type: "api", key: "sk-test" };

    const first = getSDK(makeAnthropicModel("claude-sonnet-4-20250514"), auth);
    const second = getSDK(makeAnthropicModel("claude-opus-4-20250514"), auth);

    expect(first).toBe(second);
  });

  test("returns different SDKs for different auth values", () => {
    const first = getSDK(makeOpenAIModel(), { type: "api", key: "sk-test-1" });
    const second = getSDK(makeOpenAIModel(), { type: "api", key: "sk-test-2" });

    expect(first).not.toBe(second);
  });

  test("reuses language models for the same model and auth", () => {
    const auth: Auth.Info = { type: "proxy", baseURL: "http://localhost:8317" };

    const first = getLanguage(makeAnthropicModel(), auth);
    const second = getLanguage(makeAnthropicModel(), auth);

    expect(first).toBe(second);
  });

  test("returns different language models for different models", () => {
    const auth: Auth.Info = { type: "proxy", baseURL: "http://localhost:8317" };

    const first = getLanguage(makeAnthropicModel("claude-sonnet-4-20250514"), auth);
    const second = getLanguage(makeAnthropicModel("claude-opus-4-20250514"), auth);

    expect(first).not.toBe(second);
  });

  test("returns different language models for different auth values", () => {
    const first = getLanguage(makeOpenAIModel(), { type: "api", key: "sk-test-1" });
    const second = getLanguage(makeOpenAIModel(), { type: "api", key: "sk-test-2" });

    expect(first).not.toBe(second);
  });
});
