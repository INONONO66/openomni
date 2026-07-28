import { describe, expect, test } from "bun:test";
import type { ModelCatalogService, OwnerCredentialSource, Provider, RunInput } from "../src";

describe("@openomni/llm root public surface", () => {
  test("exposes the package contract", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../src");

    // When: the consumer reads the public runtime contract.
    const publicKeys = Object.keys(root).sort();

    // Then: only package-level namespaces and entry points are exposed.
    expect(publicKeys).toEqual([
      "APIError",
      "ModelsDev",
      "NamedError",
      "OwnerCredentialSource",
      "OwnerCredentialSourceError",
      "Provider",
      "ProviderError",
      "TokenTracker",
      "run",
    ]);
  });

  test("does not expose lower-level implementation helpers", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../src");

    // When: implementation helpers are checked on the root object.
    const removedExports = [
      "ProviderTransform",
      "fetchProxyModels",
      "enrichWithCatalog",
      "Message",
      "ModelCatalogService",
      "Retry",
      "Processor",
      "Tool",
      "toModelMessages",
    ] as const;

    // Then: internal helpers remain available only through deep imports.
    for (const exportName of removedExports) {
      expect(Reflect.ownKeys(root).includes(exportName)).toBe(false);
    }
  });

  test("keeps RunInput usable as the root input contract", async () => {
    // Given: a consumer writes against root-level RunInput.
    const model: Provider.Model = {
      id: "claude-3-haiku",
      providerID: "anthropic",
      name: "Claude 3 Haiku",
      api: { npm: "@ai-sdk/anthropic" },
    };
    const credentialSource: OwnerCredentialSource = {
      providerId: "anthropic",
      credentialId: "owner-anthropic",
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: { type: "api", key: "test-key" },
    };
    const catalog: ModelCatalogService = {
      async load() {
        throw new Error("not used");
      },
      async get() {
        return {};
      },
    };
    const input: RunInput = {
      messages: [],
      tools: [],
      model,
      environment: {} as RunInput["environment"],
    };

    // When: the typed input is constructed.
    const messageCount = input.messages.length;
    const providerCount = Object.keys(await catalog.get()).length;
    const credentialProvider = credentialSource.providerId;

    // Then: the root type preserves run() input shape.
    expect(messageCount).toBe(0);
    expect(providerCount).toBe(0);
    expect(credentialProvider).toBe("anthropic");
  });
});
