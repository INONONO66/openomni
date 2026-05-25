import { describe, expect, it } from "bun:test";
import { getSDK, Provider } from "../../src/provider/index";
import type { Auth } from "../../src/auth";

function makeModel(providerID: string, npm: string, id?: string): Provider.Model {
  return {
    id: id ?? "test-model",
    providerID,
    name: "Test Model",
    api: { npm },
  };
}

describe("Provider Registry", () => {
  describe("getSDK", () => {
    it("should return configured Anthropic provider with API auth", () => {
      const auth: Auth.Info = { type: "api", key: "test-api-key" };
      const model = makeModel("anthropic", "@ai-sdk/anthropic", "claude-sonnet-4-20250514");
      const provider = getSDK(model, auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should return configured Anthropic provider with proxy auth", () => {
      const auth: Auth.Info = {
        type: "proxy",
        baseURL: "http://localhost:8317",
      };
      const model = makeModel("anthropic", "@ai-sdk/anthropic", "claude-sonnet-4-20250514");
      const provider = getSDK(model, auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should return configured OpenAI provider with API auth", () => {
      const auth: Auth.Info = { type: "api", key: "test-api-key" };
      const model = makeModel("openai", "@ai-sdk/openai", "gpt-4o");
      const provider = getSDK(model, auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should return configured OpenAI provider with proxy auth", () => {
      const auth: Auth.Info = {
        type: "proxy",
        baseURL: "http://localhost:8317/v1",
        apiKey: "test-proxy-key",
      };
      const model = makeModel("openai", "@ai-sdk/openai", "gpt-5.1-codex-max");
      const provider = getSDK(model, auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should throw error for unknown npm package", () => {
      const auth: Auth.Info = { type: "api", key: "test-api-key" };
      const model = makeModel("unknown", "unknown-npm-pkg");
      expect(() => getSDK(model, auth)).toThrow(
        "No bundled provider for npm package: unknown-npm-pkg",
      );
    });
  });

  describe("listModels", () => {
    it("should return model definitions from ModelsDev", async () => {
      const models = await Provider.listModels("anthropic");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty("id");
      expect(models[0]).toHaveProperty("name");
    });

    it("should return OpenAI model definitions", async () => {
      const models = await Provider.listModels("openai");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it("should return OpenAI models for proxy auth type without CODEX filter", async () => {
      const models = await Provider.listModels("openai", "proxy");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it("should return all OpenAI models for API auth type", async () => {
      const models = await Provider.listModels("openai", "api");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it("should throw error for unknown provider", async () => {
      return expect(Provider.listModels("unknown")).rejects.toThrow("Unknown provider: unknown");
    });
  });

  describe("listProviders", () => {
    it("should return available provider IDs", async () => {
      const providers = await Provider.listProviders();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);
      expect(providers).toContain("anthropic");
      expect(providers).toContain("openai");
    });
  });
});
