import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Auth } from "../../src/auth";
import { rmSync, existsSync } from "fs";
import { join } from "path";

const testAuthDir = join(process.env.HOME!, ".openomni-test");
const testAuthFile = join(testAuthDir, "auth.json");

describe("Auth Storage", () => {
  const originalEnv = process.env.OPENOMNI_AUTH_FILE;

  beforeEach(() => {
    process.env.OPENOMNI_AUTH_FILE = testAuthFile;
    if (existsSync(testAuthFile)) {
      rmSync(testAuthFile);
    }
    if (existsSync(testAuthDir)) {
      rmSync(testAuthDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(testAuthFile)) {
      rmSync(testAuthFile);
    }
    if (existsSync(testAuthDir)) {
      rmSync(testAuthDir, { recursive: true });
    }
    if (originalEnv) {
      process.env.OPENOMNI_AUTH_FILE = originalEnv;
    } else {
      delete process.env.OPENOMNI_AUTH_FILE;
    }
  });
  it("should write API auth to auth.json", async () => {
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

  it("should return stored value with correct Zod type", async () => {
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

  it("should return undefined for nonexistent key", async () => {
    const stored = await Auth.get("nonexistent");
    expect(stored).toBeUndefined();
  });

  it("should remove entry from auth.json", async () => {
    await Auth.set("anthropic", {
      type: "api",
      key: "sk-ant",
    });

    let stored = await Auth.get("anthropic");
    expect(stored).toBeDefined();

    await Auth.remove("anthropic");
    stored = await Auth.get("anthropic");
    expect(stored).toBeUndefined();
  });

  it("should return all entries", async () => {
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

  it("should silently skip invalid data in auth.json", async () => {
    const { mkdirSync } = await import("fs");
    const dir = testAuthDir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    await Bun.write(
      testAuthFile,
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

  it("should silently skip legacy token auth data", async () => {
    const { mkdirSync } = await import("fs");
    const dir = testAuthDir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    await Bun.write(
      testAuthFile,
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

  it("should set auth.json file with 0o600 permissions", async () => {
    await Auth.set("anthropic", {
      type: "api",
      key: "sk-ant",
    });

    const file = Bun.file(testAuthFile);
    const stat = await file.stat();
    // Check that file has restrictive permissions (0o600 = rw-------)
    const mode = stat?.mode ?? 0;
    const permissions = mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it("should work with API key auth type", async () => {
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
