import { describe, test, expect, afterEach } from "bun:test";
import { getSDK, CODEX_ALLOWED_MODELS, type Provider } from "../../src/provider/index";
import type { Auth } from "../../src/auth";

const originalFetch = globalThis.fetch;

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "gpt-4o",
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
    capabilities: { reasoning: false },
    cost: { input: 2.5, output: 10 },
    ...overrides,
  };
}

describe("getSDK (OpenAI)", () => {
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

  test("proxy auth returns SDK", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
  });

  test("proxy auth with apiKey returns SDK", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
      apiKey: "proxy-key",
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
  });
});

describe("CODEX_ALLOWED_MODELS", () => {
  test("is a Set containing expected codex models", () => {
    expect(CODEX_ALLOWED_MODELS).toBeInstanceOf(Set);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.1-codex-max")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.1-codex-mini")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.2")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.2-codex")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-5.1-codex")).toBe(true);
    expect(CODEX_ALLOWED_MODELS.has("gpt-4o")).toBe(false);
  });
});
