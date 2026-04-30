import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { Config } from "../src/config/index";

const testBase = join(process.env.TMPDIR ?? "/tmp", `openomni-cli-test-${process.pid}`);
const configDir = join(testBase, ".openomni");
const configFile = join(configDir, "config.json");

const savedConfigPath = process.env.OPENOMNI_CONFIG_PATH;

function restoreEnv() {
  if (savedConfigPath !== undefined) {
    process.env.OPENOMNI_CONFIG_PATH = savedConfigPath;
  } else {
    delete process.env.OPENOMNI_CONFIG_PATH;
  }
}

describe("Config.mask", () => {
  it("returns dots for strings of 4 chars or fewer", () => {
    expect(Config.mask("ab")).toBe("••••");
    expect(Config.mask("abcd")).toBe("••••");
  });

  it("shows last 4 chars of longer strings", () => {
    expect(Config.mask("my-secret-token")).toBe("••••oken");
    expect(Config.mask("12345678")).toBe("••••5678");
  });

  it("handles empty string", () => {
    expect(Config.mask("")).toBe("••••");
  });
});

describe("Config.load", () => {
  beforeEach(() => {
    process.env.OPENOMNI_CONFIG_PATH = configFile;
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    restoreEnv();
  });

  it("returns empty object when config file does not exist", () => {
    expect(Config.load()).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    writeFileSync(configFile, "not valid json");
    expect(Config.load()).toEqual({});
  });

  it("returns empty object for schema-invalid data", () => {
    writeFileSync(configFile, JSON.stringify({ telegram: "not-an-object" }));
    expect(Config.load()).toEqual({});
  });

  it("parses valid config", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        telegram: { token: "tg-token-123" },
        discord: { token: "dc-token-456" },
      }),
    );
    const loaded = Config.load();
    expect(loaded.telegram?.token).toBe("tg-token-123");
    expect(loaded.discord?.token).toBe("dc-token-456");
  });

  it("preserves optional fields", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        github: {
          secret: "gh-secret",
          token: "gh-token",
          botUsername: "bot",
          allowedUsers: ["u1", "u2"],
        },
      }),
    );
    const loaded = Config.load();
    expect(loaded.github?.secret).toBe("gh-secret");
    expect(loaded.github?.token).toBe("gh-token");
    expect(loaded.github?.allowedUsers).toEqual(["u1", "u2"]);
  });
});

describe("Config.save", () => {
  beforeEach(() => {
    process.env.OPENOMNI_CONFIG_PATH = configFile;
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    restoreEnv();
  });

  it("creates config directory and file", () => {
    Config.save({ telegram: { token: "t" } });
    expect(existsSync(configFile)).toBe(true);
  });

  it("writes valid JSON", () => {
    Config.save({ telegram: { token: "tg-token" } });
    const raw = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.telegram.token).toBe("tg-token");
  });

  it("sets restrictive file permissions", () => {
    Config.save({ telegram: { token: "t" } });
    const stat = statSync(configFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("Config.setAdapter", () => {
  beforeEach(() => {
    process.env.OPENOMNI_CONFIG_PATH = configFile;
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    restoreEnv();
  });

  it("adds adapter to empty config", () => {
    Config.setAdapter("telegram", { token: "tg-token" });
    const loaded = Config.load();
    expect(loaded.telegram?.token).toBe("tg-token");
  });

  it("preserves existing adapters", () => {
    Config.setAdapter("telegram", { token: "tg-token" });
    Config.setAdapter("discord", { token: "dc-token" });
    const loaded = Config.load();
    expect(loaded.telegram?.token).toBe("tg-token");
    expect(loaded.discord?.token).toBe("dc-token");
  });

  it("overwrites existing adapter", () => {
    Config.setAdapter("telegram", { token: "old" });
    Config.setAdapter("telegram", { token: "new" });
    expect(Config.load().telegram?.token).toBe("new");
  });

  it("preserves allowedUsers", () => {
    Config.setAdapter("telegram", {
      token: "tg-token",
      allowedUsers: ["user1", "user2"],
    });
    expect(Config.load().telegram?.allowedUsers).toEqual(["user1", "user2"]);
  });
});

describe("Config.removeAdapter", () => {
  beforeEach(() => {
    process.env.OPENOMNI_CONFIG_PATH = configFile;
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    restoreEnv();
  });

  it("removes specified adapter", () => {
    Config.save({
      telegram: { token: "tg" },
      discord: { token: "dc" },
    });
    const removed = Config.removeAdapter("telegram");
    expect(removed).toBe(true);

    const loaded = Config.load();
    expect(loaded.telegram).toBeUndefined();
    expect(loaded.discord?.token).toBe("dc");
  });

  it("returns false for non-existent adapter", () => {
    Config.save({});
    expect(Config.removeAdapter("telegram")).toBe(false);
  });
});
