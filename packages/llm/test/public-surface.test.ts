import { describe, expect, test } from "bun:test";

describe("@openomni/llm root public surface", () => {
  test("exposes the package contract", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../src");

    // When: the consumer reads the public runtime contract.
    const publicKeys = Object.keys(root).sort();

    // Then: only package-level namespaces and entry points are exposed.
    expect(publicKeys).toEqual([
      "APIError",
      "Auth",
      "ModelsDev",
      "NamedError",
      "Provider",
      "ProviderError",
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
      "Retry",
      "Processor",
      "Tool",
      "toModelMessages",
      // #606 re-audit: only llm-internal consumers (processor/stream-events)
      // remained; the stream fold reaches it by deep import.
      "TokenTracker",
    ] as const;

    // Then: internal helpers remain available only through deep imports.
    for (const exportName of removedExports) {
      expect(Reflect.ownKeys(root).includes(exportName)).toBe(false);
    }
  });
});
