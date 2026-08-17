import { describe, expect, it } from "bun:test";
import {
  enrichWithCatalog,
  fetchProxyModels,
  ProxyModelsError,
} from "../../src/provider/proxy-models";
import type { Provider } from "../../src/provider/index";

type FetchArgs = Parameters<typeof fetch>;

function stubFetch(
  handler: (input: FetchArgs[0], init?: FetchArgs[1]) => Response | Promise<Response>,
): { restore: () => void } {
  const original = globalThis.fetch;
  // The stub answers calls; it does not carry `fetch.preconnect`, and nothing
  // under test reaches for it. A single assertion, so the call signature is
  // still checked — `as unknown as` here would wave through any shape.
  globalThis.fetch = handler as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("proxy-models", () => {
  describe("fetchProxyModels", () => {
    it("sends Authorization header when apiKey is provided", async () => {
      let capturedHeaders: Headers | undefined;

      const stub = stubFetch((_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      try {
        const result = await fetchProxyModels("http://localhost:3100/v1", "test-key-123");
        expect(result).toEqual(["test-model"]);
        expect(capturedHeaders?.get("Authorization")).toBe("Bearer test-key-123");
      } finally {
        stub.restore();
      }
    });

    it("omits Authorization header when apiKey is not provided", async () => {
      let capturedHeaders: Headers | undefined;

      const stub = stubFetch((_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      try {
        const result = await fetchProxyModels("http://localhost:3101/v1");
        expect(result).toEqual(["test-model"]);
        expect(capturedHeaders?.get("Authorization")).toBeNull();
      } finally {
        stub.restore();
      }
    });

    // Regression (#audit M2): listing failures used to return [], and the
    // caller then fell through to the FULL models.dev catalog — silently
    // presenting every model as available on the proxy. Behavior change:
    // failures are now a typed ProxyModelsError the caller must surface.
    it("throws a typed error on auth failure (401) instead of returning []", async () => {
      const stub = stubFetch(
        () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      );

      try {
        const error = await fetchProxyModels("http://localhost:3102/v1").then(
          () => {
            throw new Error("expected fetchProxyModels to reject");
          },
          (cause: unknown) => cause,
        );
        expect(ProxyModelsError.isInstance(error)).toBe(true);
        if (ProxyModelsError.isInstance(error)) {
          expect(error.data.status).toBe(401);
          expect(error.data.url).toBe("http://localhost:3102/v1/models");
        }
      } finally {
        stub.restore();
      }
    });

    it("throws a typed error when the proxy is unreachable", async () => {
      const stub = stubFetch(() => {
        throw new Error("ECONNREFUSED");
      });

      try {
        await expect(fetchProxyModels("http://localhost:3103/v1")).rejects.toThrow(
          "proxy model listing unreachable",
        );
      } finally {
        stub.restore();
      }
    });

    it("throws a typed error when the proxy returns invalid JSON", async () => {
      const stub = stubFetch(() => new Response("<html>gateway timeout</html>", { status: 200 }));

      try {
        await expect(fetchProxyModels("http://localhost:3104/v1")).rejects.toThrow(
          "proxy model listing returned invalid JSON",
        );
      } finally {
        stub.restore();
      }
    });
  });

  describe("enrichWithCatalog", () => {
    it("returns catalog model when available, stub otherwise", () => {
      const catalog: Record<string, Provider.Model> = {
        "gpt-5.4": {
          id: "gpt-5.4",
          providerID: "openai",
          name: "GPT 5.4",
          status: "active",
        },
      };

      const result = enrichWithCatalog(["gpt-5.4", "gpt-5.5"], catalog, "openai");

      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe("GPT 5.4");
      expect(result[1]?.id).toBe("gpt-5.5");
      expect(result[1]?.name).toBe("gpt-5.5");
    });
  });
});
