import { describe, expect, it, beforeEach, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { ModelsDev } from "../src/models";
import { ANTHROPIC_MODELS } from "../src/provider/anthropic";
import { OPENAI_MODELS } from "../src/provider/openai";

describe("ModelsDev", () => {
  beforeEach(() => {
    ModelsDev._resetCache();
  });

  describe("schemas", () => {
    it("should validate a well-formed Model", () => {
      const result = ModelsDev.Model.safeParse({
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
        capabilities: { vision: true, thinking: true, tools: true },
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

  describe("fallback", () => {
    it("should return hardcoded providers with models when fetch and cache fail", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("offline")),
      ) as typeof fetch;

      const fakeCacheDir = join(tmpdir(), `openomni-test-${Date.now()}`);
      ModelsDev._setCachePath(fakeCacheDir, join(fakeCacheDir, "models.json"));
      ModelsDev._resetCache();
      try {
        const data = await ModelsDev.get();

        expect(data.anthropic).toBeDefined();
        expect(data.anthropic.id).toBe("anthropic");
        expect(data.anthropic.name).toBe("Anthropic");
        expect(data.anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);

        expect(data.openai).toBeDefined();
        expect(data.openai.id).toBe("openai");
        expect(data.openai.name).toBe("OpenAI");
        expect(data.openai.env).toEqual(["OPENAI_API_KEY"]);

        for (const m of ANTHROPIC_MODELS) {
          expect(data.anthropic.models[m.id]).toBeDefined();
        }

        for (const id of OPENAI_MODELS.map((m) => m.id)) {
          expect(data.openai.models[id]).toBeDefined();
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
