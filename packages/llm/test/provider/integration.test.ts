import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedCredential } from "../../src/auth";
import { ModelsDev, Provider } from "../../src/provider";
import { getLanguage, getSDK } from "../../src/provider/sdk";

const environment = {
  modelDigest: "b".repeat(64),
  endpoint: {
    version: "llm-endpoint-ref-v1" as const,
    kind: "default" as const,
    valueRef: "provider-default",
    endpointDigest: "c".repeat(64),
  },
  credential: {
    version: "credential-source-ref-v1" as const,
    providerId: "openai",
    authType: "api" as const,
    credentialId: "owner-default",
    rotationId: "rotation-1",
    sourceKind: "default_file" as const,
    sourcePathDigest: "d".repeat(64),
    credentialDigest: "e".repeat(64),
  },
  sdkPackage: "@ai-sdk/openai",
  adapterVersion: "1",
};

const catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: { claude: { id: "claude-api-id", name: "Claude" } },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: { gpt: { id: "gpt-api-id", name: "GPT" } },
  },
};

function credential(providerId: string): MaterializedCredential {
  return Object.freeze({
    providerId,
    authType: "api" as const,
    key: new TextEncoder().encode("test-key"),
  });
}

function proxyCredential(apiKey?: string): MaterializedCredential {
  return Object.freeze({
    providerId: "openai",
    authType: "proxy" as const,
    baseURL: "http://localhost:8317/v1",
    ...(apiKey === undefined ? {} : { apiKey: new TextEncoder().encode(apiKey) }),
  });
}

describe("Provider integration", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openomni-provider-integration-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function catalogService() {
    return ModelsDev.createService({
      cachePath: join(directory, "models.json"),
      environment,
      remoteURL: "https://models.test/catalog.json",
      dependencies: { fetchRemote: async () => ({ catalog, version: "test-v1" }) },
    });
  }

  it("lists providers and models from the explicitly supplied catalog service", async () => {
    const service = catalogService();

    expect(await Provider.listProviders(service)).toEqual(["anthropic", "openai"]);
    const anthropic = await Provider.listModels(service, "anthropic");
    const openai = await Provider.listModels(service, "openai");

    expect(anthropic.map((model) => model.id)).toEqual(["claude-api-id"]);
    expect(openai.map((model) => model.id)).toEqual(["gpt-api-id"]);
    expect(anthropic[0]?.api?.id).toBe("claude-api-id");
    expect(openai[0]?.api?.id).toBe("gpt-api-id");
  });

  it("materializes each provider with a provider-matching credential", async () => {
    const service = catalogService();
    const anthropic = (await Provider.listModels(service, "anthropic"))[0];
    const openai = (await Provider.listModels(service, "openai"))[0];
    if (!anthropic || !openai) throw new Error("expected provider models");

    expect(getLanguage(anthropic, credential("anthropic")).modelId).toBe("claude-api-id");
    expect(getLanguage(openai, credential("openai")).modelId).toBe("gpt-api-id");
  });

  it("rejects cross-provider credential use", async () => {
    const model = (await Provider.listModels(catalogService(), "anthropic"))[0];
    if (!model) throw new Error("expected anthropic model");

    expect(() => getSDK(model, credential("openai"))).toThrow(
      "Provider credential scope does not match the selected model",
    );
  });

  it("resolves an explicit custom endpoint through the OpenAI-compatible SDK", () => {
    const model: Provider.Model = {
      id: "custom-display-id",
      providerID: "custom",
      name: "Custom Model",
      api: {
        id: "custom-api-id",
        npm: "@ai-sdk/openai",
        url: "http://localhost:8317/v1",
      },
    };

    const language = getLanguage(model, credential("custom")) as {
      modelId: string;
      provider: string;
    };

    expect(language.modelId).toBe("custom-api-id");
    expect(language.provider).toBe("custom.responses");
  });

  it("selects openai.chat for an OpenAI proxy with an API key", async () => {
    const model = (await Provider.listModels(catalogService(), "openai"))[0];
    if (!model) throw new Error("expected OpenAI model");

    const language = getLanguage(model, proxyCredential("proxy-key")) as {
      modelId: string;
      provider: string;
    };

    expect(language.modelId).toBe("gpt-api-id");
    expect(language.provider).toBe("openai.chat");
  });

  it("selects openai.chat for an OpenAI proxy without an API key", async () => {
    const model = (await Provider.listModels(catalogService(), "openai"))[0];
    if (!model) throw new Error("expected OpenAI model");

    const language = getLanguage(model, proxyCredential()) as {
      modelId: string;
      provider: string;
    };

    expect(language.modelId).toBe("gpt-api-id");
    expect(language.provider).toBe("openai.chat");
  });
});
