import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../../src/auth";

const testAuthRoot = join(tmpdir(), "openomni-auth-storage-");

async function withTestAuthFile<T>(fn: (filepath: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(testAuthRoot);
  const filepath = join(dir, "auth.json");
  try {
    return await Auth.withFile(filepath, () => fn(filepath, dir));
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

describe("Auth Storage", () => {
  it.each([
    { name: "should write API auth to auth.json", provider: "anthropic", key: "sk-ant" },
    { name: "should work with API key auth type", provider: "openai", key: "sk-xxx" },
  ])("$name", async ({ provider, key }) => {
    await withTestAuthFile(async () => {
      await Auth.set(provider, { type: "api", key });
      const stored = await Auth.get(provider);
      expect(stored).toBeDefined();
      expect(stored?.type).toBe("api");
      if (stored?.type !== "api") throw new Error("expected API auth");
      expect(stored?.key).toBe(key);
    });
  });

  it("should return stored value with correct Zod type", async () => {
    await withTestAuthFile(async () => {
      await Auth.set("anthropic", {
        type: "proxy",
        baseURL: "http://localhost:8317/v1",
        apiKey: "proxy-key",
      });
      const stored = await Auth.get("anthropic");
      expect(stored).toBeDefined();
      expect(stored?.type).toBe("proxy");
      if (stored?.type !== "proxy") throw new Error("expected proxy auth");
      expect(stored?.baseURL).toBe("http://localhost:8317/v1");
      expect(stored?.apiKey).toBe("proxy-key");
    });
  });

  it("should return undefined for nonexistent key", async () => {
    await withTestAuthFile(async () => {
      expect(await Auth.get("nonexistent")).toBeUndefined();
    });
  });

  it("preserves both credentials when set calls overlap", async () => {
    await withTestAuthFile(async () => {
      await Promise.all([
        Auth.set("anthropic", { type: "api", key: "sk-ant" }),
        Auth.set("openai", { type: "api", key: "sk-openai" }),
      ]);

      expect(await Auth.all()).toEqual({
        anthropic: { type: "api", key: "sk-ant" },
        openai: { type: "api", key: "sk-openai" },
      });
    });
  });

  it("should return all entries", async () => {
    await withTestAuthFile(async () => {
      await Auth.set("anthropic", { type: "proxy", baseURL: "http://localhost:8317/v1" });
      await Auth.set("openai", { type: "api", key: "sk-xxx" });
      const all = await Auth.all();
      expect(Object.keys(all).length).toBe(2);
      expect(all.anthropic).toBeDefined();
      expect(all.openai).toBeDefined();
      expect(all.anthropic?.type).toBe("proxy");
      expect(all.openai?.type).toBe("api");
    });
  });

  it("should silently skip invalid data in auth.json", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(
        filepath,
        JSON.stringify({
          valid: { type: "api", key: "sk-valid" },
          invalid: { type: "unknown", data: "bad" },
        }),
      );
      const all = await Auth.all();
      expect(Object.keys(all).length).toBe(1);
      expect(all.valid).toBeDefined();
      expect(all.invalid).toBeUndefined();
    });
  });

  it("fails loudly on a malformed auth file instead of reading it as empty", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(filepath, "{ this is not json");
      await expect(Auth.all()).rejects.toThrow("auth file is not valid JSON");
      await expect(Auth.get("anthropic")).rejects.toThrow("auth file is not valid JSON");
      await expect(Auth.set("anthropic", { type: "api", key: "sk-new" })).rejects.toThrow(
        "auth file is not valid JSON",
      );
      expect(await Bun.file(filepath).text()).toBe("{ this is not json");
    });
  });

  it("fails loudly when the auth file is valid JSON but not an object", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(filepath, "null");
      await expect(Auth.all()).rejects.toThrow("auth file is not a JSON object");
    });
  });

  it("should silently skip legacy token auth data", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(
        filepath,
        JSON.stringify({
          legacy: { type: "oauth", refresh: "r", access: "a", expires: 999 },
        }),
      );
      const all = await Auth.all();
      expect(all.legacy).toBeUndefined();
    });
  });

  it("should set auth.json file with 0o600 permissions", async () => {
    await withTestAuthFile(async (filepath) => {
      await Auth.set("anthropic", { type: "api", key: "sk-ant" });
      const mode = (await Bun.file(filepath).stat())?.mode ?? 0;
      expect(mode & 0o777).toBe(0o600);
    });
  });
});
