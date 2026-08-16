import { describe, test, expect, afterEach } from "bun:test";
import { getSDK, getLanguage } from "../../src/provider/sdk";
import type { Provider } from "../../src/provider";
import type { Auth } from "../../src/auth";

const originalFetch = globalThis.fetch;

/** `config` is an OpenAI SDK detail, absent from the `LanguageModelV3` interface. */
type OpenAIModelRef = { readonly config?: { readonly provider?: string } };

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "gpt-4o",
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
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
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel("gpt-4o");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("gpt-4o");
  });

  test("proxy auth returns SDK", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel("gpt-4o");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("gpt-4o");
  });

  test("proxy auth with apiKey returns SDK", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
      apiKey: "proxy-key",
    };
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel("gpt-4o");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("gpt-4o");
  });

  test("proxy auth uses Chat Completions language model", () => {
    const auth: Auth.Info = {
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
      apiKey: "proxy-key",
    };
    const lm = getLanguage(makeModel({ id: "gpt-5.4" }), auth);

    expect(lm.modelId).toBe("gpt-5.4");
    expect((lm as OpenAIModelRef).config?.provider).toBe("openai.chat");
  });
});
