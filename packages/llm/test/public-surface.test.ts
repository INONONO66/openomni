import { describe, expect, test } from "bun:test";

describe("@openomni/llm root public surface", () => {
  test("exposes the package contract", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../src");

    // When: the consumer reads the public runtime contract.
    const publicKeys = Object.keys(root).sort();

    // Then: only package-level namespaces and entry points are exposed.
    expect(publicKeys).toEqual(["Auth", "ModelsDev", "Provider", "run"]);
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
      // Unexported by the #audit dead-surface pass: no production consumer
      // imported these from the root barrel (internals still use them —
      // e.g. the stream fold reaches TokenTracker by deep import, per the
      // #606 re-audit).
      "APIError",
      "NamedError",
      "ProviderError",
      "TokenTracker",
    ] as const;

    // Then: internal helpers remain available only through deep imports.
    for (const exportName of removedExports) {
      expect(Reflect.ownKeys(root).includes(exportName)).toBe(false);
    }
  });
});
