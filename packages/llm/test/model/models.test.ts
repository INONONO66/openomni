import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsDev } from "../../src/model";

describe("ModelsDev", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let directory: string;
  let originalFetch: typeof fetch;
  const network = mock(() => Promise.reject(new Error("unexpected network request")));

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    directory = mkdtempSync(join(tmpdir(), "models-test-"));
    process.env.OPENOMNI_MODELS_PATH = join(directory, "models.json");
    process.env.OPENOMNI_AUTH_FILE = join(directory, "auth.json");
    process.env.OPENOMNI_DISABLE_MODELS_FETCH = "1";
    network.mockClear();
    globalThis.fetch = Object.assign(network, { preconnect: originalFetch.preconnect });
    ModelsDev.Data.reset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    ModelsDev.Data.reset();
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
    expect(network).not.toHaveBeenCalled();
  });

  describe("public API", () => {
    it("should expose only the supported catalog operations", () => {
      expect("init" in ModelsDev).toBe(false);
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

  describe("env flags", () => {
    it("should use OPENOMNI_MODELS_PATH for cache location", async () => {
      const fakePath = join(directory, "missing", "models.json");
      process.env.OPENOMNI_MODELS_PATH = fakePath;

      delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
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
      const fakePath = join(directory, "missing", "models.json");
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
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENOMNI_MODELS_PATH;
        delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
      }
    });
  });

  describe("snapshot fallback", () => {
    it("should return data from snapshot when fetch and cache fail", async () => {
      delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        mock(() => Promise.reject(new Error("offline"))),
        {
          preconnect: originalFetch.preconnect,
        },
      );

      const fakePath = join(directory, "missing", "models.json");
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
      delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        mock(() => Promise.reject(new Error("offline"))),
        {
          preconnect: originalFetch.preconnect,
        },
      );

      const fakePath = join(directory, "missing", "models.json");
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
