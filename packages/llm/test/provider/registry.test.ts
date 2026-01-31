import { describe, expect, it } from "bun:test";
import { getProvider, listModels, listProviders } from "../../src/provider";
import type { Auth } from "../../src/auth";

describe("Provider Registry", () => {
  describe("getProvider", () => {
    it("should return configured Anthropic provider with API auth", () => {
      const auth: Auth.Info = {
        type: "api",
        key: "test-api-key",
      };

      const provider = getProvider("anthropic", auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should return configured Anthropic provider with OAuth auth", () => {
      const auth: Auth.Info = {
        type: "oauth",
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 3600000,
      };

      const provider = getProvider("anthropic", auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should return configured OpenAI provider with API auth", () => {
      const auth: Auth.Info = {
        type: "api",
        key: "test-api-key",
      };

      const provider = getProvider("openai", auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should return configured OpenAI provider with OAuth auth", () => {
      const auth: Auth.Info = {
        type: "oauth",
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 3600000,
        accountId: "test-account-id",
      };

      const provider = getProvider("openai", auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should throw error for unknown provider", () => {
      const auth: Auth.Info = {
        type: "api",
        key: "test-api-key",
      };

      expect(() => getProvider("unknown", auth)).toThrow(
        "Unknown provider: unknown",
      );
    });
  });

  describe("listModels", () => {
    it("should return Anthropic model definitions", () => {
      const models = listModels("anthropic");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      if (Array.isArray(models)) {
        expect(models.length).toBeGreaterThan(0);
        expect(models[0]).toHaveProperty("id");
        expect(models[0]).toHaveProperty("name");
        expect(models[0]).toHaveProperty("capabilities");
      }
    });

    it("should return OpenAI model definitions without auth type filter", () => {
      const models = listModels("openai");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      const gpt4o = models.find((m) => m.id === "gpt-4o");
      expect(gpt4o).toBeDefined();
      expect(gpt4o).toHaveProperty("name");
      expect(gpt4o).toHaveProperty("cost");
    });

    it("should return filtered OpenAI models for OAuth auth type", () => {
      const models = listModels("openai", "oauth");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models.find((m) => m.id === "gpt-5.1-codex-max")).toBeDefined();
      expect(models.find((m) => m.id === "gpt-4o")).toBeUndefined();
    });

    it("should return all OpenAI models for API auth type", () => {
      const models = listModels("openai", "api");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models.find((m) => m.id === "gpt-4o")).toBeDefined();
      expect(models.find((m) => m.id === "gpt-5.1-codex-max")).toBeDefined();
    });

    it("should throw error for unknown provider", () => {
      expect(() => listModels("unknown")).toThrow("Unknown provider: unknown");
    });
  });

  describe("listProviders", () => {
    it("should return supported provider IDs", () => {
      const providers = listProviders();
      expect(providers).toEqual(["anthropic", "openai"]);
    });
  });
});
