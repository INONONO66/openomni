import { describe, expect, test } from "bun:test";
import ts from "typescript";
import type { Sink } from "../src";

describe("@openomni/llm root public surface", () => {
  test("967 public sink excludes fact tap", async () => {
    // Given: the public type and its machine-readable declaration.
    const callbacks = {
      onMessage: true,
      onToolCall: true,
      onToolResult: true,
    } satisfies Record<keyof Sink, true>;
    const source = ts.createSourceFile(
      "sink.ts",
      await Bun.file(new URL("../src/sink.ts", import.meta.url)).text(),
      ts.ScriptTarget.Latest,
      true,
    );

    // When: TypeScript parses the callback members (not comments or prose).
    const contract = source.statements.find(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === "Sink",
    );

    // Then: only retained callbacks are public; the typed map is exhaustive too.
    expect(contract?.members.map((member) => member.name?.getText(source)).sort()).toEqual(
      Object.keys(callbacks).sort(),
    );
  });

  test("exposes the package contract", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../src");

    // When: the consumer reads the public runtime contract.
    const publicKeys = Object.keys(root).sort();

    // Then: only package-level namespaces and entry points are exposed.
    // #500 C1: `Run` (Outcome vocabulary) moved here from protocol; `Sink` is type-only.
    expect(publicKeys).toEqual([
      "Auth",
      "ModelsDev",
      "Provider",
      "Retry",
      "Run",
      "accumulateUsage",
      "observeRetry",
      "run",
      "selectModel",
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
