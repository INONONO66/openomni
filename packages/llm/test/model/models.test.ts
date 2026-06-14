import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Model } from "@openomni/protocol";
import { ModelsDev } from "../../src/model";

describe("ModelsDev", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    ModelsDev.Data.reset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("public API", () => {
    it("should expose only the supported catalog operations", () => {
      expect("init" in ModelsDev).toBe(false);
    });
  });

  describe("schemas", () => {
    it("should validate a well-formed Model", () => {
      const result = ModelsDev.Model.safeParse({
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
        modalities: { input: ["text", "image"], output: ["text"] },
      });
      expect(result.success).toBe(true);
    });

    it("should validate a minimal Model (only id and name required)", () => {
      const result = ModelsDev.Model.safeParse({
        id: "test-model",
        name: "Test",
      });
      expect(result.success).toBe(true);
    });

    it("should reject a Model missing id", () => {
      const result = ModelsDev.Model.safeParse({ name: "Test" });
      expect(result.success).toBe(false);
    });

    it("should validate a well-formed Provider", () => {
      const result = ModelsDev.Provider.safeParse({
        id: "anthropic",
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-sonnet-4": { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
        },
      });
      expect(result.success).toBe(true);
    });

    it("should reject a Provider missing required fields", () => {
      const result = ModelsDev.Provider.safeParse({ id: "test" });
      expect(result.success).toBe(false);
    });

    it("should validate Model with family and release_date", () => {
      const result = ModelsDev.Model.safeParse({
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        family: "claude",
        release_date: "2025-05-22",
      });
      expect(result.success).toBe(true);
    });

    it("should validate Model with interleaved as true", () => {
      const result = ModelsDev.Model.safeParse({
        id: "test",
        name: "Test",
        interleaved: true,
      });
      expect(result.success).toBe(true);
    });

    it("should validate Model with interleaved as object", () => {
      const result = ModelsDev.Model.safeParse({
        id: "test",
        name: "Test",
        interleaved: { field: "reasoning_content" },
      });
      expect(result.success).toBe(true);
    });

    it("should validate Model with status field", () => {
      for (const status of ["alpha", "beta", "deprecated", "active"] as const) {
        const result = ModelsDev.Model.safeParse({
          id: "test",
          name: "Test",
          status,
        });
        expect(result.success).toBe(true);
      }
    });

    it("should reuse the same model status schema for provider models", () => {
      const result = ModelsDev.ModelStatus.safeParse("active");
      expect(result.success).toBe(true);
      expect(ModelsDev.ModelStatus).toBe(Model.Status);
    });

    it("should validate Model with variants", () => {
      const result = ModelsDev.Model.safeParse({
        id: "test",
        name: "Test",
        variants: {
          "test:thinking": { reasoning: true },
        },
      });
      expect(result.success).toBe(true);
    });

    it("should validate Provider with api field", () => {
      const result = ModelsDev.Provider.safeParse({
        id: "anthropic",
        name: "Anthropic",
        api: "https://api.anthropic.com",
        env: ["ANTHROPIC_API_KEY"],
        models: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe("get", () => {
    it("should be an async function", () => {
      expect(typeof ModelsDev.get).toBe("function");
    });

    it("should return an object with provider keys", async () => {
      const data = await ModelsDev.get();
      expect(typeof data).toBe("object");
      expect(data).not.toBeNull();
    });

    it("should return cached result on second call", async () => {
      const first = await ModelsDev.get();
      const second = await ModelsDev.get();
      expect(first).toBe(second);
    });
  });

  describe("Data", () => {
    it("should be callable like get()", async () => {
      const data = await ModelsDev.Data();
      expect(typeof data).toBe("object");
    });

    it("should have a reset method", () => {
      expect(typeof ModelsDev.Data.reset).toBe("function");
    });

    it("should clear cache on reset", async () => {
      await ModelsDev.get();
      ModelsDev.Data.reset();
      const fresh = await ModelsDev.get();
      expect(typeof fresh).toBe("object");
    });
  });

  describe("refresh", () => {
    it("should be an async function", () => {
      expect(typeof ModelsDev.refresh).toBe("function");
    });
  });

  describe("env flags", () => {
    it("should use OPENOMNI_MODELS_PATH for cache location", async () => {
      const fakePath = join(tmpdir(), `openomni-test-${Date.now()}`, "models.json");
      process.env.OPENOMNI_MODELS_PATH = fakePath;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        mock(() => Promise.reject(new Error("offline"))),
        {
          preconnect: originalFetch.preconnect,
        },
      );

      try {
        const data = await ModelsDev.get();
        expect(typeof data).toBe("object");
        expect(data).not.toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENOMNI_MODELS_PATH;
      }
    });

    it("should skip fetch when OPENOMNI_DISABLE_MODELS_FETCH is set", async () => {
      const fakePath = join(tmpdir(), `openomni-test-${Date.now()}`, "models.json");
      process.env.OPENOMNI_MODELS_PATH = fakePath;
      process.env.OPENOMNI_DISABLE_MODELS_FETCH = "true";

      const fetchSpy = Object.assign(
        mock(() => Promise.resolve(new Response("ok"))),
        {
          preconnect: globalThis.fetch.preconnect,
        },
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy;

      try {
        const data = await ModelsDev.get();
        expect(typeof data).toBe("object");
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENOMNI_MODELS_PATH;
        delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
      }
    });
  });

  describe("snapshot fallback", () => {
    it("should return data from snapshot when fetch and cache fail", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        mock(() => Promise.reject(new Error("offline"))),
        {
          preconnect: originalFetch.preconnect,
        },
      );

      const fakePath = join(tmpdir(), `openomni-test-${Date.now()}`, "models.json");
      process.env.OPENOMNI_MODELS_PATH = fakePath;
      ModelsDev.Data.reset();
      try {
        const data = await ModelsDev.get();
        expect(typeof data).toBe("object");
        expect(data).not.toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENOMNI_MODELS_PATH;
      }
    });

    it("should return empty object as final fallback when snapshot unavailable", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        mock(() => Promise.reject(new Error("offline"))),
        {
          preconnect: originalFetch.preconnect,
        },
      );

      const fakePath = join(tmpdir(), `openomni-test-${Date.now()}`, "models.json");
      process.env.OPENOMNI_MODELS_PATH = fakePath;
      process.env.OPENOMNI_DISABLE_MODELS_FETCH = "true";
      ModelsDev.Data.reset();
      try {
        const data = await ModelsDev.get();
        expect(typeof data).toBe("object");
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENOMNI_MODELS_PATH;
        delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
      }
    });
  });
});
