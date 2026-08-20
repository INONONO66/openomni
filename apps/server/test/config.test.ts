import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Operational, type McpConfig } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { loadConfig } from "../src/config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function flushBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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
    Bus.reset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    Bus.reset();
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

    const config = loadConfig("trace-test", configPath);
    expect(config.telegram.token).toBe("file-telegram-token");
    expect(config.discord.token).toBe("file-discord-token");
    expect(config.github.secret).toBe("file-github-secret");
    expect(config.server.wsToken).toBe("file-ws-token");
  });

  it("preserves protocol MCP server fields from the config file", () => {
    const configPath = join(tempDir, "config.json");
    const servers: McpConfig.ServerConfig[] = [
      {
        name: "remote",
        transport: "streamable-http",
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer file-token" },
        timeout: 12_000,
        retries: 2,
      },
    ];
    writeFileSync(configPath, JSON.stringify({ mcp: { servers } }));

    const config = loadConfig("trace-test", configPath);
    expect(config.mcp.servers).toEqual(servers);
  });

  it("drops invalid MCP server entries at the config boundary", async () => {
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (payload) => warnings.push(payload));
    const configPath = join(tempDir, "config.json");
    const valid: McpConfig.ServerConfig = {
      name: "valid",
      transport: "stdio",
      command: "node",
    };
    writeFileSync(
      configPath,
      JSON.stringify({
        mcp: {
          servers: [valid, { name: "invalid", transport: "websocket", url: "ws://localhost" }],
        },
      }),
    );

    const config = loadConfig("trace-test", configPath);
    await flushBus();
    unsubscribe();

    expect(config.mcp.servers).toEqual([valid]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid mcp server config ignored",
        context: expect.objectContaining({
          source: "server-config",
          configPath,
          rejected: [
            expect.objectContaining({
              index: 1,
              name: "invalid",
            }),
          ],
        }),
      }),
    );
  });

  it("treats non-array MCP servers as empty at the config boundary", async () => {
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (payload) => warnings.push(payload));
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcp: { servers: { name: "bad", transport: "stdio" } } }),
    );

    const config = loadConfig("trace-test", configPath);
    await flushBus();
    unsubscribe();

    expect(config.mcp.servers).toEqual([]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid mcp server config ignored",
        context: expect.objectContaining({
          source: "server-config",
          configPath,
          rejected: [expect.objectContaining({ index: -1, error: "servers must be an array" })],
        }),
      }),
    );
  });

  it("uses env var when config file value is missing for telegram token", () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-telegram-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ telegram: {} }));

    const config = loadConfig("trace-test", configPath);
    expect(config.telegram.token).toBe("env-telegram-token");
  });

  it("uses env var when config file value is missing for discord token", () => {
    process.env.DISCORD_BOT_TOKEN = "env-discord-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ discord: {} }));

    const config = loadConfig("trace-test", configPath);
    expect(config.discord.token).toBe("env-discord-token");
  });

  it("uses env var when config file value is missing for github secret", () => {
    process.env.GITHUB_WEBHOOK_SECRET = "env-github-secret";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ github: {} }));

    const config = loadConfig("trace-test", configPath);
    expect(config.github.secret).toBe("env-github-secret");
  });

  it("uses env var when config file value is missing for ws token", () => {
    process.env.WS_AUTH_TOKEN = "env-ws-token";
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ server: {} }));

    const config = loadConfig("trace-test", configPath);
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

    const config = loadConfig("trace-test", configPath);
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

    const config = loadConfig("trace-test", configPath);
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

    const config = loadConfig("trace-test", configPath);
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

    const config = loadConfig("trace-test", configPath);
    expect(config.server.wsToken).toBe("env-ws-token");
  });

  it("parses messaging.personaActorId and replyGrantRules; defaults stay fail-closed empty (#708)", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        messaging: {
          personaActorId: "actor:persona",
          replyGrantRules: [
            {
              id: "rule-1",
              senderId: "actor:persona",
              surface: "telegram",
              operations: ["awaited"],
              instanceTtlMs: 60_000,
              maxLiveInstances: 3,
              createdBy: "owner",
            },
          ],
        },
      }),
    );

    const config = loadConfig("trace-test", configPath);
    expect(config.messaging.personaActorId).toBe("actor:persona");
    expect(config.messaging.replyGrantRules).toHaveLength(1);
    expect(config.messaging.replyGrantRules[0]).toMatchObject({ id: "rule-1" });

    const emptyPath = join(tempDir, "empty.json");
    writeFileSync(emptyPath, JSON.stringify({}));
    const empty = loadConfig("trace-test", emptyPath);
    expect(empty.messaging.personaActorId).toBeUndefined();
    expect(empty.messaging.replyGrantRules).toEqual([]);
    expect(empty.messaging.grants).toEqual([]);
  });

  it("drops malformed persona/reply-grant config fail-closed with a warning (#708)", async () => {
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (payload) => warnings.push(payload));
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        messaging: {
          personaActorId: "",
          replyGrantRules: [{ id: "rule-broken" }],
        },
      }),
    );

    const config = loadConfig("trace-test", configPath);
    await flushBus();
    unsubscribe();

    expect(config.messaging.personaActorId).toBeUndefined();
    expect(config.messaging.replyGrantRules).toEqual([]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid messaging.personaActorId config ignored; as-me sends stay fail-closed",
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid messaging.replyGrantRules config ignored; no reply-grant instances materialize",
      }),
    );
  });

  it("resolves permissionProfiles per tier; defaults empty (고도화 A)", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        permissionProfiles: {
          collaborator: { denyLabels: ["capability:write", "capability:destructive"] },
          observer: {
            denyLabels: ["capability:write", "capability:destructive", "capability:read"],
          },
        },
      }),
    );

    const config = loadConfig("trace-test", configPath);
    expect(config.permissionProfiles.collaborator).toEqual({
      denyLabels: ["capability:write", "capability:destructive"],
    });
    expect(config.permissionProfiles.observer?.denyLabels).toContain("capability:read");
    // A tier with no entry stays absent → no relaxation, no cap.
    expect(config.permissionProfiles.owner).toBeUndefined();

    const emptyPath = join(tempDir, "empty-profiles.json");
    writeFileSync(emptyPath, JSON.stringify({}));
    expect(loadConfig("trace-test", emptyPath).permissionProfiles).toEqual({});
  });

  it("drops malformed permissionProfiles entries fail-closed with a warning (고도화 A)", async () => {
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (payload) => warnings.push(payload));
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        permissionProfiles: {
          // Unknown tier key → dropped.
          overlord: { denyLabels: ["capability:write"] },
          // Malformed overlay shape → dropped.
          manager: { denyLabels: "capability:write" },
          // Valid → kept.
          collaborator: { denyLabels: ["capability:write"] },
        },
      }),
    );

    const config = loadConfig("trace-test", configPath);
    await flushBus();
    unsubscribe();

    expect(config.permissionProfiles.collaborator).toEqual({ denyLabels: ["capability:write"] });
    expect((config.permissionProfiles as Record<string, unknown>).overlord).toBeUndefined();
    expect(config.permissionProfiles.manager).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid permissionProfiles entry ignored; that tier stays at its base permission",
        context: expect.objectContaining({ tier: "overlord" }),
      }),
    );
  });

  it("treats a non-object permissionProfiles block as empty, fail-closed (고도화 A)", async () => {
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (payload) => warnings.push(payload));
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ permissionProfiles: ["capability:write"] }));

    const config = loadConfig("trace-test", configPath);
    await flushBus();
    unsubscribe();

    expect(config.permissionProfiles).toEqual({});
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid permissionProfiles config ignored; every tier stays at its base permission",
      }),
    );
  });

  it("returns undefined when neither config file nor env var is set", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.WS_AUTH_TOKEN;

    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));

    const config = loadConfig("trace-test", configPath);
    expect(config.telegram.token).toBeUndefined();
    expect(config.discord.token).toBeUndefined();
    expect(config.github.secret).toBeUndefined();
    expect(config.server.wsToken).toBeUndefined();
  });
});
