import { describe, expect, it } from "bun:test";
import type { Auth } from "../../src/auth";
import { Provider } from "../../src/provider";
import { getSDK } from "../../src/provider/sdk";

function makeModel(providerID: string, npm: string, id = "test-model"): Provider.Model {
  return { id, providerID, name: "Test Model", api: { npm } };
}

const sdkCases: Array<{
  name: string;
  providerID: string;
  npm: string;
  id: string;
  auth: Auth.Info;
}> = [
  {
    name: "Anthropic provider with API auth",
    providerID: "anthropic",
    npm: "@ai-sdk/anthropic",
    id: "claude-sonnet-4-20250514",
    auth: { type: "api", key: "test-api-key" },
  },
  {
    name: "Anthropic provider with proxy auth",
    providerID: "anthropic",
    npm: "@ai-sdk/anthropic",
    id: "claude-sonnet-4-20250514",
    auth: { type: "proxy", baseURL: "http://localhost:8317" },
  },
  {
    name: "OpenAI provider with API auth",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    id: "gpt-4o",
    auth: { type: "api", key: "test-api-key" },
  },
  {
    name: "OpenAI provider with proxy auth",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    id: "gpt-5.1-codex-max",
    auth: { type: "proxy", baseURL: "http://localhost:8317/v1", apiKey: "test-proxy-key" },
  },
];

const modelListCases: Array<{
  name: string;
  provider: "anthropic" | "openai";
  auth?: "proxy" | "api";
  properties: boolean;
}> = [
  { name: "model definitions from ModelsDev", provider: "anthropic", properties: true },
  { name: "OpenAI model definitions", provider: "openai", properties: false },
  {
    name: "OpenAI models for proxy auth type without CODEX filter",
    provider: "openai",
    auth: "proxy",
    properties: false,
  },
  {
    name: "all OpenAI models for API auth type",
    provider: "openai",
    auth: "api",
    properties: false,
  },
];

describe("Provider Registry", () => {
  describe("public surface", () => {
    it("does not expose removed dead provider namespace members", async () => {
      const providerSource = await Bun.file(
        new URL("../../src/provider/index.ts", import.meta.url),
      ).text();
      expect(Object.hasOwn(Provider, "BUNDLED_PROVIDERS")).toBe(false);
      expect(providerSource).not.toMatch(/\bexport\s+const\s+BUNDLED_PROVIDERS\b/);
      expect(providerSource).not.toMatch(/\bexport\s+type\s+ProviderID\b/);
    });
  });

  describe("getSDK", () => {
    it.each(sdkCases)("should return configured $name", ({ providerID, npm, id, auth }) => {
      const provider = getSDK(makeModel(providerID, npm, id), auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should throw error for unknown npm package", () => {
      expect(() =>
        getSDK(makeModel("unknown", "unknown-npm-pkg"), { type: "api", key: "test-api-key" }),
      ).toThrow("No bundled provider for npm package: unknown-npm-pkg");
    });

    it("treats Object.prototype keys as unknown npm packages", () => {
      const auth: Auth.Info = { type: "api", key: "test-api-key" };
      for (const npm of ["toString", "constructor", "valueOf"]) {
        expect(() => getSDK(makeModel("unknown", npm), auth)).toThrow(
          `No bundled provider for npm package: ${npm}`,
        );
      }
    });
  });

  describe("listModels", () => {
    it.each(modelListCases)("should return $name", async ({ provider, auth, properties }) => {
      const models = await Provider.listModels(provider, auth);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      if (properties) {
        expect(models[0]).toHaveProperty("id");
        expect(models[0]).toHaveProperty("name");
      }
    });

    it("should throw error for unknown provider", async () => {
      return expect(Provider.listModels("unknown")).rejects.toThrow("Unknown provider: unknown");
    });
  });
});
