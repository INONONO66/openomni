import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetConfig, loadConfig } from "../src/config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config", () => {
  let tempDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openomni-config-test-"));
    originalEnv = {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
      WS_AUTH_TOKEN: process.env.WS_AUTH_TOKEN,
    };
    resetConfig();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    resetConfig();
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it("loads config from file", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: { token: "file-telegram-token" },
        discord: { token: "file-discord-token" },
        github: { secret: "file-github-secret" },
        server: { wsToken: "file-ws-token" },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.telegram.token).toBe("file-telegram-token");
    expect(config.discord.token).toBe("file-discord-token");
    expect(config.github.secret).toBe("file-github-secret");
    expect(config.server.wsToken).toBe("file-ws-token");
  });

  it("uses env var when config file value is missing for telegram token", () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-telegram-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ telegram: {} }));

    const config = loadConfig(configPath);
    expect(config.telegram.token).toBe("env-telegram-token");
  });

  it("uses env var when config file value is missing for discord token", () => {
    process.env.DISCORD_BOT_TOKEN = "env-discord-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ discord: {} }));

    const config = loadConfig(configPath);
    expect(config.discord.token).toBe("env-discord-token");
  });

  it("uses env var when config file value is missing for github secret", () => {
    process.env.GITHUB_WEBHOOK_SECRET = "env-github-secret";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ github: {} }));

    const config = loadConfig(configPath);
    expect(config.github.secret).toBe("env-github-secret");
  });

  it("uses env var when config file value is missing for ws token", () => {
    process.env.WS_AUTH_TOKEN = "env-ws-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ server: {} }));

    const config = loadConfig(configPath);
    expect(config.server.wsToken).toBe("env-ws-token");
  });

  it("env var overrides config file value for telegram token", () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-telegram-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: { token: "file-telegram-token" },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.telegram.token).toBe("env-telegram-token");
  });

  it("env var overrides config file value for discord token", () => {
    process.env.DISCORD_BOT_TOKEN = "env-discord-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        discord: { token: "file-discord-token" },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.discord.token).toBe("env-discord-token");
  });

  it("env var overrides config file value for github secret", () => {
    process.env.GITHUB_WEBHOOK_SECRET = "env-github-secret";
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        github: { secret: "file-github-secret" },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.github.secret).toBe("env-github-secret");
  });

  it("env var overrides config file value for ws token", () => {
    process.env.WS_AUTH_TOKEN = "env-ws-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server: { wsToken: "file-ws-token" },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.server.wsToken).toBe("env-ws-token");
  });

  it("returns undefined when neither config file nor env var is set", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.WS_AUTH_TOKEN;

    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));

    const config = loadConfig(configPath);
    expect(config.telegram.token).toBeUndefined();
    expect(config.discord.token).toBeUndefined();
    expect(config.github.secret).toBeUndefined();
    expect(config.server.wsToken).toBeUndefined();
  });
});
