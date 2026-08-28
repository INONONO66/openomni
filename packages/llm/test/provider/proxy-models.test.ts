import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Provider } from "../../src/provider/index";
import {
  enrichWithCatalog,
  fetchProxyModels,
  ProxyModelsError,
} from "../../src/provider/proxy-models";

type FetchArgs = Parameters<typeof fetch>;
const originalFetch = globalThis.fetch;

function stubFetch(
  handler: (input: FetchArgs[0], init?: FetchArgs[1]) => Response | Promise<Response>,
): void {
  globalThis.fetch = handler as typeof fetch;
}

describe("proxy-models", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchProxyModels", () => {
    it.each([
      {
        name: "sends Authorization header when apiKey is provided",
        port: 3100,
        apiKey: "test-key-123",
        expected: "Bearer test-key-123",
      },
      {
        name: "omits Authorization header when apiKey is not provided",
        port: 3101,
        apiKey: undefined,
        expected: null,
      },
    ])("$name", async ({ port, apiKey, expected }) => {
      let capturedHeaders: Headers | undefined;
      stubFetch((_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const result = await fetchProxyModels(`http://localhost:${port}/v1`, apiKey);
      expect(result).toEqual(["test-model"]);
      expect(capturedHeaders?.get("Authorization")).toBe(expected);
    });

    it("does not share cached model lists between credentials at the same URL", async () => {
      const authorizationHeaders: Array<string | null> = [];
      stubFetch((_input, init) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        authorizationHeaders.push(authorization);
        const id = authorization === "Bearer credential-a" ? "model-a" : "model-b";
        return new Response(JSON.stringify({ data: [{ id }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      expect(await fetchProxyModels("http://localhost:3110/v1", "credential-a")).toEqual([
        "model-a",
      ]);
      expect(await fetchProxyModels("http://localhost:3110/v1", "credential-b")).toEqual([
        "model-b",
      ]);
      expect(authorizationHeaders).toEqual(["Bearer credential-a", "Bearer credential-b"]);
    });

    it("throws a typed error on auth failure (401) instead of returning []", async () => {
      stubFetch(() => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
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
    });

    it.each([
      {
        name: "throws a typed error when the proxy is unreachable",
        port: 3103,
        response: () => {
          throw new Error("ECONNREFUSED");
        },
        message: "proxy model listing unreachable",
      },
      {
        name: "throws a typed error when the proxy returns invalid JSON",
        port: 3104,
        response: () => new Response("<html>gateway timeout</html>", { status: 200 }),
        message: "proxy model listing returned invalid JSON",
      },
    ])("$name", async ({ port, response, message }) => {
      stubFetch(response);
      await expect(fetchProxyModels(`http://localhost:${port}/v1`)).rejects.toThrow(message);
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
