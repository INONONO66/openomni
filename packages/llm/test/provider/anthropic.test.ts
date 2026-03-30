import { describe, test, expect, afterEach } from "bun:test";
import { getSDK, getLanguage, type Provider } from "../../src/provider/index";
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
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel("claude-sonnet-4-20250514");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("proxy auth returns SDK with languageModel", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317",
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel("claude-sonnet-4-20250514");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("claude-sonnet-4-20250514");
  });
});

describe("getLanguage (Anthropic)", () => {
  test("returns a language model for anthropic model with api auth", () => {
    const auth: Auth.Info = { type: "api", key: "sk-xxx" };
    const model = getLanguage(makeModel(), auth);
    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("returns a language model for proxy auth", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317",
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
    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-3-haiku");
  });
});
