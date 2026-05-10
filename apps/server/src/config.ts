import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

type McpServerConfig = {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
};

const DEFAULT_CONFIG_PATH = join(homedir(), ".openomni", "config.json");

interface RawConfig {
  workspace?: {
    root?: string;
  };
  mcp?: {
    servers?: McpServerConfig[];
  };
  server?: {
    port?: number;
    host?: string;
    wsToken?: string;
  };
  storage?: {
    dbPath?: string;
  };
  telegram?: {
    token?: string;
    allowedUsers?: string[];
  };
  github?: {
    secret?: string;
    token?: string;
    botUsername?: string;
    allowedUsers?: string[];
  };
  discord?: {
    token?: string;
    allowedUsers?: string[];
  };
}

export interface ServerConfig {
  workspace?: { root: string };
  mcp: { servers: McpServerConfig[] };
  server: { port: number; host: string; wsToken?: string };
  storage: { dbPath: string };
  telegram: { token?: string; allowedUsers: string[] };
  github: { secret?: string; token?: string; botUsername?: string; allowedUsers: string[] };
  discord: { token?: string; allowedUsers: string[] };
}

let _config: ServerConfig | null = null;
let _configPath: string | null = null;

function loadRaw(configPath: string): RawConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as RawConfig;
  } catch {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "failed to parse config, using defaults",
      context: { configPath },
    });
    return {};
  }
}

function resolve(raw: RawConfig): ServerConfig {
  const defaultDbPath = join(homedir(), ".openomni", "storage.db");
  const workspaceRoot = raw.workspace?.root;

  if (workspaceRoot && !existsSync(workspaceRoot)) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "workspace root not found",
      context: { workspaceRoot },
    });
  }

  return {
    workspace: workspaceRoot ? { root: workspaceRoot } : undefined,
    mcp: {
      servers: raw.mcp?.servers ?? [],
    },
    server: {
      port: raw.server?.port ?? 3000,
      host: raw.server?.host ?? "127.0.0.1",
      wsToken: process.env.WS_AUTH_TOKEN?.trim() || raw.server?.wsToken,
    },
    storage: {
      dbPath: raw.storage?.dbPath ?? defaultDbPath,
    },
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN?.trim() || raw.telegram?.token,
      allowedUsers: raw.telegram?.allowedUsers ?? [],
    },
    github: {
      secret: process.env.GITHUB_WEBHOOK_SECRET?.trim() || raw.github?.secret,
      token: raw.github?.token,
      botUsername: raw.github?.botUsername,
      allowedUsers: raw.github?.allowedUsers ?? [],
    },
    discord: {
      token: process.env.DISCORD_BOT_TOKEN?.trim() || raw.discord?.token,
      allowedUsers: raw.discord?.allowedUsers ?? [],
    },
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): ServerConfig {
  if (_config && _configPath === configPath) return _config;
  _config = resolve(loadRaw(configPath));
  _configPath = configPath;
  return _config;
}

export function getConfig(): ServerConfig {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}

export function resetConfig(): void {
  _config = null;
  _configPath = null;
}
