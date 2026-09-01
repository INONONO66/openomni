import { homedir } from "node:os";
import { join } from "node:path";
import { Actor, Gateway, Machine } from "@openomni/protocol";
import { z } from "zod";

export interface OpenOmniConfig {
  readonly dbPath: string;
  /** The built-in curated memory file (kernel-contract §5). */
  readonly memoryPath: string;
  readonly host: string;
  readonly wsPort: number;
  /** Required for non-loopback hosts; every ws sender is granted owner tier. */
  readonly wsToken?: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly apiKey: string;
    /**
     * Operator-chosen provider endpoint, replacing the models.dev catalog's.
     * Absent keeps the catalog URL.
     */
    readonly baseUrl?: string;
    /**
     * Operator-chosen request headers for every model call (tenant routing,
     * gateway auth, a fleet user-agent). Absent sends only this client's own
     * identity, which any entry here overrides by name.
     */
    readonly headers?: Readonly<Record<string, string>>;
  };
  /**
   * Absent means this brain has no body: no socket is bound and machine-placed
   * tools are simply not offered. Present requires at least one enrollment,
   * because a socket nothing is allowed to attach to is a contradiction.
   */
  readonly machines?: {
    readonly socketPath: string;
    readonly enrolled: readonly Machine.Enrollment[];
  };
  /**
   * External actors the Owner has admitted as delegation targets. Absent
   * means the channel transport has nobody to reach: sends are denied
   * ungranted rather than the driver being unwired.
   */
  readonly actors?: readonly RegisteredActor[];
  /** External channel credentials. A missing credential leaves that driver unwired. */
  readonly channels?: {
    readonly discord?: { readonly token: string };
    readonly telegram?: { readonly token: string };
    readonly github?: {
      readonly secret: string;
      readonly token?: string;
      readonly botUsername?: string;
    };
  };
  /** Owner-declared allowances for cold proactive sends; absent denies all. */
  readonly socialBudgets?: readonly Gateway.SocialBudget[];
}

export interface RegisteredActor {
  readonly actorId: string;
  /** The identity the actor's connection declares (`?actor=<externalId>`). */
  readonly externalId: string;
  /** The configured delivery surface; existing configs remain WebSocket actors. */
  readonly channel?: "ws" | "discord" | "telegram";
  readonly trustTier: Actor.TrustTier;
  readonly kind: Actor.Kind;
  readonly displayName?: string;
}

/**
 * The operator's transport config in the shape the agent and llm packages
 * take, or absent when the operator configured neither. One owner for the
 * translation, so every call site (Resident, worker loop, process worker, the
 * llm tool) sends the same thing.
 */
export function modelTransport(
  model: OpenOmniConfig["model"],
): { baseUrl?: string; headers?: Record<string, string> } | undefined {
  if (model.baseUrl === undefined && model.headers === undefined) return undefined;
  return {
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function portFromEnv(): number {
  const raw = process.env.OPENOMNI_WS_PORT;
  if (raw === undefined) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("OPENOMNI_WS_PORT must be an integer from 0 to 65535");
  }
  return port;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// The gateway grants every ws sender owner tier (src/gateway.ts), so a
// non-loopback bind without upgrade authentication would expose owner-tier
// ingress to the network. startOpenOmni calls this before binding — the
// single enforcement layer for this invariant, covering injected config too.
export function assertWsExposure(config: Pick<OpenOmniConfig, "host" | "wsToken">): void {
  if (!LOOPBACK_HOSTS.has(config.host) && (config.wsToken === undefined || config.wsToken.length === 0)) {
    throw new Error("OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback");
  }
}

/**
 * Header maps are the operator's, so they are validated as a shape rather
 * than trusted: a non-object, a non-string value, or an unnamed header is a
 * misconfiguration that must fail at boot, not produce a silently dropped
 * header on every model call.
 */
const ModelHeaders = z.record(
  z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
  z.string().regex(/^[^\r\n]*$/),
);

const Enrollments = z.array(Machine.Enrollment).min(1);
const SocialBudgets = z.array(Gateway.SocialBudget);

const Actors = z
  .array(
    z
      .object({
        actorId: z.string().min(1),
        externalId: z.string().min(1),
        channel: z.enum(["ws", "discord", "telegram"]).optional(),
        trustTier: Actor.TrustTier,
        kind: Actor.Kind.default("human"),
        displayName: z.string().min(1).optional(),
      })
      .strict(),
  )
  .min(1);

/** Reads an env var holding JSON, naming the variable on both parse and schema failure. */
function parseEnvJson<T>(
  name: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: z.ZodError } },
): T | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is invalid JSON: ${String(error)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${name} is invalid: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

/**
 * Like enrollment, actor admission is the Owner's decision read from config:
 * who may be delegated to is never inferred from whoever connects.
 */
function actorsFromEnv(): OpenOmniConfig["actors"] {
  return parseEnvJson("OPENOMNI_ACTORS", Actors);
}

function channelsFromEnv(): OpenOmniConfig["channels"] {
  const discordToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const githubSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const githubBotUsername = process.env.GITHUB_BOT_USERNAME?.trim();
  if (!discordToken && !telegramToken && !githubSecret) return undefined;
  return {
    ...(discordToken ? { discord: { token: discordToken } } : {}),
    ...(telegramToken ? { telegram: { token: telegramToken } } : {}),
    ...(githubSecret
      ? {
          github: {
            secret: githubSecret,
            ...(githubToken ? { token: githubToken } : {}),
            ...(githubBotUsername ? { botUsername: githubBotUsername } : {}),
          },
        }
      : {}),
  };
}

function socialBudgetsFromEnv(): OpenOmniConfig["socialBudgets"] {
  return parseEnvJson("OPENOMNI_SOCIAL_BUDGETS", SocialBudgets);
}

function modelFromEnv(): OpenOmniConfig["model"] {
  const baseUrl = process.env.OPENOMNI_MODEL_BASE_URL?.trim();
  const headers = parseEnvJson("OPENOMNI_MODEL_HEADERS", ModelHeaders);
  return {
    provider: required("OPENOMNI_MODEL_PROVIDER"),
    id: required("OPENOMNI_MODEL_ID"),
    apiKey: required("OPENOMNI_MODEL_API_KEY"),
    ...(baseUrl === undefined || baseUrl.length === 0 ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/**
 * Enrollment is the Owner's admission decision, so it is read from config
 * rather than inferred from whoever connects. Ledger-backed enrollment is a
 * later slice; the shape the host consumes is already the protocol's.
 */
function machinesFromEnv(): OpenOmniConfig["machines"] {
  const enrolled = parseEnvJson("OPENOMNI_MACHINES_ENROLLED", Enrollments);
  if (enrolled === undefined) return undefined;
  return {
    socketPath:
      process.env.OPENOMNI_MACHINES_SOCKET?.trim() || join(homedir(), ".openomni", "machines.sock"),
    enrolled,
  };
}

export function loadConfig(): OpenOmniConfig {
  const host = process.env.OPENOMNI_WS_HOST?.trim() || "127.0.0.1";
  const wsToken = process.env.OPENOMNI_WS_TOKEN?.trim();
  const machines = machinesFromEnv();
  const actors = actorsFromEnv();
  const channels = channelsFromEnv();
  const socialBudgets = socialBudgetsFromEnv();
  return {
    dbPath: process.env.OPENOMNI_DB_PATH?.trim() || join(homedir(), ".openomni", "storage.db"),
    memoryPath:
      process.env.OPENOMNI_MEMORY_PATH?.trim() || join(homedir(), ".openomni", "memory.json"),
    host,
    wsPort: portFromEnv(),
    ...(wsToken === undefined || wsToken.length === 0 ? {} : { wsToken }),
    model: modelFromEnv(),
    ...(machines === undefined ? {} : { machines }),
    ...(actors === undefined ? {} : { actors }),
    ...(channels === undefined ? {} : { channels }),
    ...(socialBudgets === undefined ? {} : { socialBudgets }),
  };
}
