import { describe, expect, test } from "bun:test";
import type { MaterializedCredential } from "../../src/auth";
import type { Provider } from "../../src/provider";
import { getLanguage, getSDK } from "../../src/provider/sdk";

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: { id: "claude-sonnet-4-20250514", npm: "@ai-sdk/anthropic" },
    capabilities: { reasoning: true },
    cost: { input: 3, output: 15 },
    limit: { context: 200000, output: 16384 },
    ...overrides,
  };
}

const apiCredential: MaterializedCredential = Object.freeze({
  providerId: "anthropic",
  authType: "api",
  key: new TextEncoder().encode("sk-test"),
});

const proxyCredential: MaterializedCredential = Object.freeze({
  providerId: "anthropic",
  authType: "proxy",
  baseURL: "http://localhost:8317",
});

describe("Anthropic provider materialization", () => {
  test("creates a callback-scoped SDK from a matching API credential", () => {
    const sdk = getSDK(makeModel(), apiCredential);
    const language = sdk.languageModel("claude-sonnet-4-20250514");

    expect(language.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("creates a language model from a matching proxy credential", () => {
    const language = getLanguage(makeModel(), proxyCredential);

    expect(language.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("selects the explicit api.id instead of the catalog display id", () => {
    const language = getLanguage(
      makeModel({
        id: "friendly-catalog-name",
        api: { id: "claude-3-haiku", npm: "@ai-sdk/anthropic" },
      }),
      apiCredential,
    );

    expect(language.modelId).toBe("claude-3-haiku");
  });

  test("rejects a credential materialized for another provider", () => {
    const credential: MaterializedCredential = Object.freeze({
      providerId: "openai",
      authType: "api",
      key: new TextEncoder().encode("sk-test"),
    });

    expect(() => getLanguage(makeModel(), credential)).toThrow(
      "Provider credential scope does not match the selected model",
    );
  });
});
