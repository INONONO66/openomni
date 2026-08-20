import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Actor, Gateway, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
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
    personaActorId?: unknown;
    replyGrantRules?: unknown;
  };
  permissionProfiles?: unknown;
}

/**
 * 고도화 A — the Owner-declared tier→tool-set permission cap, expressed as an
 * additive deny-label overlay (NOT a name enumeration, NOT a permission
 * replacement). The only knob is `denyLabels`: capability labels
 * (`capability:write` / `capability:destructive` / `capability:read`, stamped
 * on every tool by `defineTool`) or risk tiers (`risk:tier-N`). These union
 * into the resident's effective `Policy.Permission.denyLabels` at composition,
 * so the deny-wins ordering caps the tier WITHOUT discarding the agent's own
 * allowlist/denylist. Restricting the shape to `denyLabels` keeps this a cap,
 * never a way to WIDEN authority. The type is inlined into `ServerConfig`
 * (not a named export) so the shape stays server-config-local.
 */
const TierPermissionProfileSchema = z.object({
  denyLabels: z.array(z.string().min(1)),
});

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
  /**
   * Existing-agent messaging (#215/#708): `grants` default EMPTY — every send
   * is denied `ungranted` until a grant is explicitly configured.
   * `personaActorId` is the Owner-owned resident persona actor every as-me
   * send is attributed to; unset → the message.send tool fails closed with a
   * typed "persona not configured" result. `replyGrantRules` are the
   * Owner-written stage-0 rules the gateway materializes bounded reply-scoped
   * grant instances from (design §2b); default EMPTY.
   */
  messaging: {
    grants: Gateway.SenderTargetGrant[];
    personaActorId?: string;
    replyGrantRules: Gateway.ReplyGrantRule[];
  };
  /**
   * 고도화 A — per-tier deny-label overlays keyed by `Actor.TrustTier`. Default
   * EMPTY: with no profile configured, every tier stays at its base permission
   * (no relaxation, no extra cap). A malformed entry is dropped per-tier
   * (fail-closed: that tier gets NO relaxation), never crashing boot.
   *
   * The Owner declares the tier→tool-set cap as DATA in `config.json`; a
   * read/analysis-only collaborator is one config block:
   *
   * ```json
   * {
   *   "permissionProfiles": {
   *     "collaborator": { "denyLabels": ["capability:write", "capability:destructive"] },
   *     "observer": { "denyLabels": ["capability:write", "capability:destructive", "capability:read"] }
   *   }
   * }
   * ```
   *
   * `owner` / `co_owner` / `manager` are intentionally omitted → no overlay,
   * tools unchanged. The overlay composes AFTER the `evidence_only` hard gate
   * (evidence still wins deny-all) and merges INTO the agent's own permission
   * (additive deny; the agent's allowlist/denylist survive).
   */
  permissionProfiles: Partial<Record<Actor.TrustTier, { denyLabels: string[] }>>;
}

let _config: ServerConfig | null = null;
let _configPath: string | null = null;

function loadRaw(configPath: string, traceId: string): RawConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as RawConfig;
  } catch {
    Bus.publish(
      Operational.Events.Warn,
      Operational.envelope({
        traceId,
        component: "server",
        msg: "failed to parse config, using defaults",
        context: { configPath },
      }),
    );
    return {};
  }
}

function resolveMessagingGrants(
  raw: RawConfig,
  configPath: string,
  traceId: string,
): Gateway.SenderTargetGrant[] {
  if (raw.messaging?.grants === undefined) return [];
  const parsed = z.array(Gateway.SenderTargetGrant).safeParse(raw.messaging.grants);
  if (parsed.success) return parsed.data;
  // Fail closed: a malformed grant list grants nothing.
  Bus.publish(
    Operational.Events.Warn,
    Operational.envelope({
      traceId,
      component: "server",
      msg: "invalid messaging.grants config ignored; all existing-agent sends stay denied",
      context: { configPath, error: parsed.error.message },
    }),
  );
  return [];
}

function resolveReplyGrantRules(
  raw: RawConfig,
  configPath: string,
  traceId: string,
): Gateway.ReplyGrantRule[] {
  if (raw.messaging?.replyGrantRules === undefined) return [];
  const parsed = z.array(Gateway.ReplyGrantRule).safeParse(raw.messaging.replyGrantRules);
  if (parsed.success) return parsed.data;
  // Fail closed: a malformed rule list materializes nothing.
  Bus.publish(
    Operational.Events.Warn,
    Operational.envelope({
      traceId,
      component: "server",
      msg: "invalid messaging.replyGrantRules config ignored; no reply-grant instances materialize",
      context: { configPath, error: parsed.error.message },
    }),
  );
  return [];
}

function resolvePersonaActorId(
  raw: RawConfig,
  configPath: string,
  traceId: string,
): string | undefined {
  const value = raw.messaging?.personaActorId;
  if (value === undefined) return undefined;
  const parsed = z.string().min(1).safeParse(value);
  if (parsed.success) return parsed.data;
  // Fail closed: a malformed persona id configures no persona — the
  // message.send tool keeps returning its typed "persona not configured"
  // result instead of sending under a garbage identity.
  Bus.publish(
    Operational.Events.Warn,
    Operational.envelope({
      traceId,
      component: "server",
      msg: "invalid messaging.personaActorId config ignored; as-me sends stay fail-closed",
      context: { configPath },
    }),
  );
  return undefined;
}

function resolvePermissionProfiles(
  raw: RawConfig,
  configPath: string,
  traceId: string,
): Partial<Record<Actor.TrustTier, { denyLabels: string[] }>> {
  const value = raw.permissionProfiles;
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // Fail closed: a non-object profiles block caps nothing and relaxes
    // nothing — every tier stays at its base permission.
    Bus.publish(
      Operational.Events.Warn,
      Operational.envelope({
        traceId,
        component: "server",
        msg: "invalid permissionProfiles config ignored; every tier stays at its base permission",
        context: { configPath },
      }),
    );
    return {};
  }
  const resolved: Partial<Record<Actor.TrustTier, { denyLabels: string[] }>> = {};
  for (const [tier, profile] of Object.entries(value)) {
    const tierParsed = Actor.TrustTier.safeParse(tier);
    const profileParsed = TierPermissionProfileSchema.safeParse(profile);
    if (tierParsed.success && profileParsed.success) {
      resolved[tierParsed.data] = profileParsed.data;
      continue;
    }
    // Fail closed per entry: an unknown tier key or a malformed overlay is
    // dropped, so THAT tier gets no relaxation (and no accidental cap either).
    Bus.publish(
      Operational.Events.Warn,
      Operational.envelope({
        traceId,
        component: "server",
        msg: "invalid permissionProfiles entry ignored; that tier stays at its base permission",
        context: { configPath, tier },
      }),
    );
  }
  return resolved;
}

function resolve(raw: RawConfig, configPath: string, traceId: string): ServerConfig {
  const defaultDbPath = join(homedir(), ".openomni", "storage.db");
  const workspaceRoot = raw.workspace?.root;

  if (workspaceRoot && !existsSync(workspaceRoot)) {
    Bus.publish(
      Operational.Events.Warn,
      Operational.envelope({
        traceId,
        component: "server",
        msg: "workspace root not found",
        context: { workspaceRoot },
      }),
    );
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
        traceId,
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
      grants: resolveMessagingGrants(raw, configPath, traceId),
      personaActorId: resolvePersonaActorId(raw, configPath, traceId),
      replyGrantRules: resolveReplyGrantRules(raw, configPath, traceId),
    },
    permissionProfiles: resolvePermissionProfiles(raw, configPath, traceId),
  };
}

/**
 * `traceId` is the caller's boot trace: config loading is mid-boot, not a
 * trace origin, so every parse/validation warning files under the startup
 * that produced it.
 */
export function loadConfig(traceId: string, configPath = DEFAULT_CONFIG_PATH): ServerConfig {
  if (_config && _configPath === configPath) return _config;
  _config = resolve(loadRaw(configPath, traceId), configPath, traceId);
  _configPath = configPath;
  return _config;
}
