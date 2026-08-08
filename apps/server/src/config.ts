import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { SenderTargetGrant } from "@openomni/openomni/messaging";
import { z } from "zod";
import { parseMcpServerConfigs, type McpServerConfig } from "./config/mcp-server-config";

const DEFAULT_CONFIG_PATH = join(homedir(), ".openomni", "config.json");

interface RawConfig {
  workspace?: {
    root?: string;
  };
  model?: {
    provider?: string;
    id?: string;
    providerOptions?: Record<string, unknown>;
  };
  mcp?: {
    servers?: unknown;
  };
  server?: {
    port?: number;
    host?: string;
    wsToken?: string;
    adminToken?: string;
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
  messaging?: {
    grants?: unknown;
  };
}

export interface ServerConfig {
  workspace?: { root: string };
  model?: { provider: string; id: string; providerOptions?: Record<string, unknown> };
  mcp: { servers: McpServerConfig[] };
  /** `adminToken` guards `/admin/ledger/*` (#510 D3); the surface fails closed (401) while it is unset. */
  server: { port: number; host: string; wsToken?: string; adminToken?: string };
  storage: { dbPath: string };
  telegram: { token?: string; allowedUsers: string[] };
  github: { secret?: string; token?: string; botUsername?: string; allowedUsers: string[] };
  discord: { token?: string; allowedUsers: string[] };
  /** Existing-agent messaging grants: default EMPTY — every send is denied `ungranted` until a grant is explicitly configured. */
  messaging: { grants: SenderTargetGrant[] };
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

function resolveMessagingGrants(raw: RawConfig, configPath: string): SenderTargetGrant[] {
  if (raw.messaging?.grants === undefined) return [];
  const parsed = z.array(SenderTargetGrant).safeParse(raw.messaging.grants);
  if (parsed.success) return parsed.data;
  // Fail closed: a malformed grant list grants nothing.
  Bus.publish(Operational.Warn, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "invalid messaging.grants config ignored; all existing-agent sends stay denied",
    context: { configPath, error: parsed.error.message },
  });
  return [];
}

function resolve(raw: RawConfig, configPath: string): ServerConfig {
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

  const model =
    raw.model?.provider && raw.model?.id
      ? {
          provider: raw.model.provider,
          id: raw.model.id,
          ...(raw.model.providerOptions ? { providerOptions: raw.model.providerOptions } : {}),
        }
      : undefined;

  return {
    workspace: workspaceRoot ? { root: workspaceRoot } : undefined,
    model,
    mcp: {
      servers: parseMcpServerConfigs(raw.mcp?.servers, {
        source: "server-config",
        configPath,
      }),
    },
    server: {
      port: raw.server?.port ?? 3000,
      host: raw.server?.host ?? "127.0.0.1",
      wsToken: process.env.WS_AUTH_TOKEN?.trim() || raw.server?.wsToken,
      adminToken: process.env.OPENOMNI_ADMIN_TOKEN?.trim() || raw.server?.adminToken,
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
    messaging: {
      grants: resolveMessagingGrants(raw, configPath),
    },
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): ServerConfig {
  if (_config && _configPath === configPath) return _config;
  _config = resolve(loadRaw(configPath), configPath);
  _configPath = configPath;
  return _config;
}
