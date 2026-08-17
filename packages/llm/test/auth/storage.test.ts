import { describe, it, expect } from "bun:test";
import { Auth } from "../../src/auth";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testAuthRoot = join(tmpdir(), "openomni-auth-storage-");

async function withTestAuthFile<T>(fn: (filepath: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(testAuthRoot);
  const filepath = join(dir, "auth.json");

  try {
    return await Auth.withFile(filepath, () => fn(filepath, dir));
  } finally {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe("Auth Storage", () => {
  it("should write API auth to auth.json", async () => {
    await withTestAuthFile(async () => {
      await Auth.set("anthropic", {
        type: "api",
        key: "sk-ant",
      });

      const stored = await Auth.get("anthropic");
      expect(stored).toBeDefined();
      expect(stored?.type).toBe("api");
      if (stored?.type !== "api") throw new Error("expected API auth");
      expect(stored?.key).toBe("sk-ant");
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
      const stored = await Auth.get("nonexistent");
      expect(stored).toBeUndefined();
    });
  });

  it("should return all entries", async () => {
    await withTestAuthFile(async () => {
      await Auth.set("anthropic", {
        type: "proxy",
        baseURL: "http://localhost:8317/v1",
      });

      await Auth.set("openai", {
        type: "api",
        key: "sk-xxx",
      });

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
          valid: {
            type: "api",
            key: "sk-valid",
          },
          invalid: {
            type: "unknown",
            data: "bad",
          },
        }),
      );

      const all = await Auth.all();
      expect(Object.keys(all).length).toBe(1);
      expect(all.valid).toBeDefined();
      expect(all.invalid).toBeUndefined();
    });
  });

  it("fails loudly on a malformed auth file instead of reading it as empty", async () => {
    // Regression (#audit L4): a parse failure used to become `{}`, and the
    // next set() would overwrite the file — destroying every credential.
    await withTestAuthFile(async (filepath) => {
      await Bun.write(filepath, "{ this is not json");

      await expect(Auth.all()).rejects.toThrow("auth file is not valid JSON");
      await expect(Auth.get("anthropic")).rejects.toThrow("auth file is not valid JSON");
      // set() must refuse too — writing would destroy the stored credentials.
      await expect(Auth.set("anthropic", { type: "api", key: "sk-new" })).rejects.toThrow(
        "auth file is not valid JSON",
      );

      // The malformed file survives untouched for manual recovery.
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
          legacy: {
            type: "oauth",
            refresh: "r",
            access: "a",
            expires: 999,
          },
        }),
      );

      const all = await Auth.all();
      expect(all.legacy).toBeUndefined();
    });
  });

  it("should set auth.json file with 0o600 permissions", async () => {
    await withTestAuthFile(async (filepath) => {
      await Auth.set("anthropic", {
        type: "api",
        key: "sk-ant",
      });

      const file = Bun.file(filepath);
      const stat = await file.stat();
      // Check that file has restrictive permissions (0o600 = rw-------)
      const mode = stat?.mode ?? 0;
      const permissions = mode & 0o777;
      expect(permissions).toBe(0o600);
    });
  });

  it("should work with API key auth type", async () => {
    await withTestAuthFile(async () => {
      await Auth.set("openai", {
        type: "api",
        key: "sk-xxx",
      });

      const stored = await Auth.get("openai");
      expect(stored).toBeDefined();
      expect(stored?.type).toBe("api");
      if (stored?.type !== "api") throw new Error("expected API auth");
      expect(stored?.key).toBe("sk-xxx");
    });
  });
});
