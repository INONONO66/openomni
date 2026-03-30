import { describe, expect, it } from "bun:test";
import type { Auth } from "../../src/auth";
import { getSDK, getLanguage, Provider } from "../../src/provider/index";

function makeAnthropicModel(id?: string): Provider.Model {
  return {
    id: id ?? "claude-sonnet-4-20250514",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: { npm: "@ai-sdk/anthropic" },
    capabilities: { reasoning: true },
    cost: { input: 3, output: 15 },
  };
}

function makeOpenAIModel(id?: string): Provider.Model {
  return {
    id: id ?? "gpt-4o",
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { reasoning: false },
    cost: { input: 2.5, output: 10 },
  };
}

describe("Provider Integration", () => {
  it("full flow: getSDK → getLanguage (Anthropic API)", () => {
    const auth: Auth.Info = { type: "api", key: "test-anthropic-key" };
    const model = makeAnthropicModel();

    const sdk = getSDK(model, auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const sdkLm = sdk.languageModel(model.id);
    expect(sdkLm).toBeDefined();
    expect(sdkLm.modelId).toBe(model.id);

    const lm = getLanguage(model, auth);
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe(model.id);
  });

  it("full flow: getSDK → getLanguage (Anthropic proxy)", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317",
    };
    const model = makeAnthropicModel("claude-opus-4-20250514");

    const sdk = getSDK(model, auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const sdkLm = sdk.languageModel(model.id);
    expect(sdkLm).toBeDefined();
    expect(sdkLm.modelId).toBe(model.id);

    const lm = getLanguage(model, auth);
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe(model.id);
  });

  it("full flow: getSDK returns valid OpenAI SDK (API)", () => {
    const auth: Auth.Info = { type: "api", key: "test-openai-key" };
    const model = makeOpenAIModel();

    const sdk = getSDK(model, auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");

    const lm = sdk.languageModel("gpt-4o");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("gpt-4o");
  });

  it("full flow: getSDK returns valid OpenAI SDK (proxy)", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
      apiKey: "test-proxy-api-key",
    };
    const model = makeOpenAIModel("gpt-5.1-codex-max");

    const sdk = getSDK(model, auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel(model.id);
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe(model.id);
  });

  it("should list all available providers", async () => {
    const providers = await Provider.listProviders();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
  });

  it("should list models for each provider", async () => {
    const anthropicModels = await Provider.listModels("anthropic");
    expect(Array.isArray(anthropicModels)).toBe(true);
    expect(anthropicModels.length).toBeGreaterThan(0);

    const openaiModels = await Provider.listModels("openai");
    expect(Array.isArray(openaiModels)).toBe(true);
    expect(openaiModels.length).toBeGreaterThan(0);
  });

  it("should filter OpenAI models by auth type", async () => {
    const proxyModels = await Provider.listModels("openai", "proxy");
    expect(Array.isArray(proxyModels)).toBe(true);
    expect(proxyModels.find((m) => m.id === "gpt-5.1-codex-max")).toBeDefined();
    expect(proxyModels.find((m) => m.id === "gpt-4o")).toBeUndefined();

    const apiModels = await Provider.listModels("openai", "api");
    expect(Array.isArray(apiModels)).toBe(true);
    expect(apiModels.length).toBeGreaterThan(0);
  });

  it("snapshot fallback provides data when ModelsDev is loaded", async () => {
    const providers = await Provider.listProviders();
    expect(providers.length).toBeGreaterThan(0);
  });
});
