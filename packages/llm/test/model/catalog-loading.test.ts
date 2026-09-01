import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsDev } from "../../src/model";

type RemoteCatalogCase = {
  readonly name: string;
  readonly catalog: Record<string, unknown>;
  readonly select: (data: Record<string, ModelsDev.Provider>) => unknown;
  readonly expected: unknown;
};

const remoteCatalogCases: RemoteCatalogCase[] = [
  {
    name: "prefers a successful fetch over the bundled snapshot",
    catalog: {
      "test-network-provider": {
        api: "https://attacker.example/v1",
        id: "test-network-provider",
        name: "Network Provider",
        env: ["TEST_NETWORK_PROVIDER_API_KEY"],
        npm: "@ai-sdk/openai",
        models: {
          "test-network-model": {
            id: "test-network-model",
            name: "Network Model",
            provider: { npm: "@ai-sdk/anthropic" },
          },
        },
      },
    },
    select: (data) => data["test-network-provider"],
    expected: {
      env: ["TEST_NETWORK_PROVIDER_API_KEY"],
      id: "test-network-provider",
      models: { "test-network-model": { id: "test-network-model", name: "Network Model" } },
      name: "Network Provider",
      npm: "@ai-sdk/openai",
    },
  },
  {
    name: "drops custom providers without a bundled SDK",
    catalog: {
      custom: {
        api: "https://attacker.example/v1",
        id: "custom",
        name: "Custom Provider",
        env: ["CUSTOM_API_KEY"],
        models: { "custom-model": { id: "custom-model", name: "Custom Model" } },
      },
    },
    select: (data) => data.custom,
    expected: undefined,
  },
  {
    name: "removes model-level provider packages",
    catalog: {
      openai: {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        models: {
          "gpt-test": {
            id: "gpt-test",
            name: "GPT Test",
            provider: { npm: "@ai-sdk/anthropic" },
          },
        },
      },
    },
    select: (data) => data.openai?.models["gpt-test"],
    expected: { id: "gpt-test", name: "GPT Test" },
  },
];

describe("ModelsDev catalog loading", () => {
  const originalEnv = { ...process.env };
  let testCacheDir: string | undefined;

  beforeEach(() => {
    ModelsDev.Data.reset();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (testCacheDir) {
      await rm(testCacheDir, { force: true, recursive: true });
      testCacheDir = undefined;
    }
  });

  async function writeCacheCatalog(content: unknown): Promise<void> {
    testCacheDir = mkdtempSync(join(tmpdir(), "openomni-models-cache-"));
    process.env.OPENOMNI_MODELS_PATH = join(testCacheDir, "models.json");
    process.env.OPENOMNI_DISABLE_MODELS_FETCH = "1";
    await Bun.write(
      process.env.OPENOMNI_MODELS_PATH,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }

  describe("get", () => {
    it.each(remoteCatalogCases)("$name", async ({ catalog, select, expected }) => {
      testCacheDir = mkdtempSync(join(tmpdir(), "openomni-models-network-"));
      process.env.OPENOMNI_MODELS_PATH = join(testCacheDir, "models.json");
      delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;

      const originalFetch = globalThis.fetch;
      const fetchSpy = Object.assign(
        mock(() =>
          Promise.resolve(
            new Response(JSON.stringify(catalog), {
              headers: { "content-type": "application/json" },
              status: 200,
            }),
          ),
        ),
        { preconnect: originalFetch.preconnect },
      );
      globalThis.fetch = fetchSpy;

      try {
        const data = await ModelsDev.get();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(select(data)).toEqual(expected);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not trust provider api urls from an existing trusted-provider cache file", async () => {
      await writeCacheCatalog({
        cached: {
          api: "https://attacker.example/v1",
          id: "cached",
          name: "Cached Provider",
          env: ["CACHED_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {},
        },
      });

      const data = await ModelsDev.get();
      expect(data.cached).toEqual({
        id: "cached",
        name: "Cached Provider",
        env: ["CACHED_API_KEY"],
        npm: "@ai-sdk/openai",
        models: {},
      });
    });



    it("should fall back to the bundled snapshot when the cache sanitizes to nothing", async () => {
      await writeCacheCatalog({
        openai: null,
        anthropic: {
          id: "anthropic",
          name: "Anthropic",
          env: "ANTHROPIC_API_KEY",
          npm: "@ai-sdk/anthropic",
          models: {},
        },
      });

      const snapshot = (await import("../../src/model/models-snapshot.json")).default;
      await expect(ModelsDev.get()).resolves.toEqual(snapshot);
    });

    it("should drop malformed model records from trusted providers", async () => {
      await writeCacheCatalog({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {
            malformed: { family: "no-id-or-name" },
            valid: { id: "valid", name: "Valid Model" },
          },
        },
      });

      const data = await ModelsDev.get();
      expect(data.openai?.models).toEqual({ valid: { id: "valid", name: "Valid Model" } });
    });

    it("should not let prototype keys mutate sanitized catalog objects", async () => {
      await writeCacheCatalog(`{
          "__proto__": {
            id: "__proto__",
            name: "Polluted",
            env: [],
            npm: "@ai-sdk/openai",
            models: {
              "__proto__": {
                id: "__proto__",
                name: "Polluted Model",
              },
            },
          }
        }`);

      const data = await ModelsDev.get();
      expect(Reflect.ownKeys(data).includes("__proto__")).toBe(false);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
  });
});
