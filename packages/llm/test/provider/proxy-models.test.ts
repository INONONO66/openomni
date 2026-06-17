import { describe, expect, it } from "bun:test";
import { enrichWithCatalog, fetchProxyModels } from "../../src/provider/proxy-models";
import type { Provider } from "../../src/provider/index";

function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
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
        capturedHeaders = new Headers(init?.headers as HeadersInit);
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
        capturedHeaders = new Headers(init?.headers as HeadersInit);
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

    it("returns empty array on auth failure (401)", async () => {
      const stub = stubFetch(
        () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      );

      try {
        const result = await fetchProxyModels("http://localhost:3102/v1");
        expect(result).toEqual([]);
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
          capabilities: { reasoning: true },
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
