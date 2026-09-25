import { homedir } from "node:os";
import { join } from "node:path";
import { Actor, Gateway, Machine, NamedError, type Model } from "@openomni/protocol";
import { z } from "zod";

export const ConfigurationError = NamedError.create(
  "OpenOmniConfigurationError",
  z.object({
    code: z.enum(["invalid_compaction_summarizer", "invalid_ws_port", "legacy_channel_credentials"]),
    message: z.string(),
    replacement: z.object({ tool: z.literal("provision"), op: z.literal("channel_add") }).optional(),
  }),
);
export type ConfigurationError = InstanceType<typeof ConfigurationError>;

export interface OpenOmniConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly wsPort: number;
  /** Enabled unless explicitly disabled with OPENOMNI_COMPACTION_SUMMARIZER=off. */
  readonly compactionSummarizer?: boolean;
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
    /**
     * Ordered models tried AFTER `id` when a run's failures advance the
     * chain (the agent loop's `modelFallbacks`). Absent means every attempt
     * uses the primary.
     */
    readonly fallbacks?: readonly Model.Ref[];
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
  /** Owner-declared allowances for cold proactive sends; absent denies all. */
  readonly socialBudgets?: readonly Gateway.SocialBudget[];
  /**
   * Per-surface sender allowlists for the trusted-channel grant (external
   * ids on that surface, e.g. Telegram user ids). A surface listed here
   * serves only the listed senders; everyone else finds no grant and the
   * perimeter blocks fail-closed. A surface absent from the map keeps the
   * open posture — acceptable only for loopback-bound surfaces like ws.
   */
  readonly channelAllowedSenders?: Readonly<Record<string, readonly string[]>>;
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

/**
 * The one parser for `OPENOMNI_WS_PORT`: `startOpenOmni` binds what this
 * returns, so every other reader (doctor's health probe) must ask here
 * rather than re-deriving a port the daemon never bound. `0` is a legal
 * ephemeral bind, and an unset value resolves to the same default the
 * daemon uses — the default has no second home.
 */
export function parseWsPort(raw: string | undefined): number {
  if (raw === undefined) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigurationError({
      code: "invalid_ws_port",
      message: "OPENOMNI_WS_PORT must be an integer from 0 to 65535",
    });
  }
  return port;
}

function compactionSummarizerFromEnv(): boolean {
  const raw = process.env.OPENOMNI_COMPACTION_SUMMARIZER?.trim();
  if (raw === undefined || raw.length === 0) return true;
  if (raw === "off") return false;
  throw new ConfigurationError({
    code: "invalid_compaction_summarizer",
    message: 'OPENOMNI_COMPACTION_SUMMARIZER must be "off" when set',
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// The gateway grants every ws sender owner tier (src/gateway.ts), so a
// non-loopback bind without upgrade authentication would expose owner-tier
// ingress to the network. startOpenOmni calls this before binding — the
// single enforcement layer for this invariant, covering injected config too.
export function assertWsExposure(config: Pick<OpenOmniConfig, "host" | "wsToken">): void {
  if (
    !LOOPBACK_HOSTS.has(config.host) &&
    (config.wsToken === undefined || config.wsToken.length === 0)
  ) {
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

/**
 * `OPENOMNI_MODEL_FALLBACKS` — the chain the run advances to, as a
 * comma-separated list of `provider/model` entries, in order:
 *
 *     OPENOMNI_MODEL_FALLBACKS="openai/gpt-5,anthropic/claude-x"
 *
 * Surrounding whitespace around each entry is trimmed; only the FIRST slash
 * separates, so a model id containing slashes (`openrouter/meta-llama/llama-4`)
 * survives intact. Validation is fail-closed on the whole variable: an entry
 * with no separator, an empty segment, or inner whitespace rejects the boot
 * rather than silently shortening the chain — a fallback the operator thinks
 * they configured but which never loads is worse than no fallback at all.
 */
// The bundled catalog intentionally supports only these provider SDKs. Keep
// this synchronous with config parsing so an unknown fallback cannot defer its
// failure until a live turn reaches it.
const CATALOG_PROVIDER_IDS = new Set(["anthropic", "openai"]);

function modelFallbacksFromEnv(): readonly Model.Ref[] | undefined {
  const raw = process.env.OPENOMNI_MODEL_FALLBACKS?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("/");
    const provider = separator === -1 ? "" : trimmed.slice(0, separator);
    const id = separator === -1 ? "" : trimmed.slice(separator + 1);
    if (provider.length === 0 || id.length === 0 || /\s/.test(trimmed)) {
      throw new Error(
        `OPENOMNI_MODEL_FALLBACKS is invalid: "${entry}" is not a "provider/model" entry`,
      );
    }
    if (!CATALOG_PROVIDER_IDS.has(provider)) {
      throw new Error(
        `OPENOMNI_MODEL_FALLBACKS is invalid: provider "${provider}" is not in the bundled catalog`,
      );
    }
    return { provider, id };
  });
}

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
function parseEnvJson<T>(name: string, schema: z.ZodType<T>): T | undefined {
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

const ChannelAllowedSenders = z.record(z.string(), z.array(z.string().min(1)).min(1));

function channelAllowedSendersFromEnv(): OpenOmniConfig["channelAllowedSenders"] {
  return parseEnvJson("OPENOMNI_CHANNEL_ALLOWED_SENDERS", ChannelAllowedSenders);
}

/** Declared ChannelInstance rows are the sole channel provisioning owner. */
export function assertDeclaredChannelConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const legacy = ["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET"]
    .filter((key) => (env[key]?.trim().length ?? 0) > 0);
  if (legacy.length > 0) {
    throw new ConfigurationError({
      code: "legacy_channel_credentials",
      message: `Remove ${legacy.join(", ")}; use the provision tool with op channel_add to declare channels.`,
      replacement: { tool: "provision", op: "channel_add" },
    });
  }
}

function socialBudgetsFromEnv(): OpenOmniConfig["socialBudgets"] {
  return parseEnvJson("OPENOMNI_SOCIAL_BUDGETS", SocialBudgets);
}

function modelFromEnv(): OpenOmniConfig["model"] {
  const baseUrl = process.env.OPENOMNI_MODEL_BASE_URL?.trim();
  const headers = parseEnvJson("OPENOMNI_MODEL_HEADERS", ModelHeaders);
  const fallbacks = modelFallbacksFromEnv();
  return {
    provider: required("OPENOMNI_MODEL_PROVIDER"),
    id: required("OPENOMNI_MODEL_ID"),
    apiKey: required("OPENOMNI_MODEL_API_KEY"),
    ...(baseUrl === undefined || baseUrl.length === 0 ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    ...(fallbacks === undefined ? {} : { fallbacks }),
  };
}

/**
 * Enrollment is the Owner's admission decision, so it is read from config
 * rather than inferred from whoever connects. Ledger-backed enrollment is a
 * later slice; the shape the host consumes is already the protocol's.
 */
function machinesFromEnv(home: string): OpenOmniConfig["machines"] {
  const enrolled = parseEnvJson("OPENOMNI_MACHINES_ENROLLED", Enrollments);
  if (enrolled === undefined) return undefined;
  return {
    socketPath:
      process.env.OPENOMNI_MACHINES_SOCKET?.trim() || join(home, ".openomni", "machines.sock"),
    enrolled,
  };
}

export function loadConfig(home: string = homedir()): OpenOmniConfig {
  assertDeclaredChannelConfig();
  const host = process.env.OPENOMNI_WS_HOST?.trim() || "127.0.0.1";
  const wsToken = process.env.OPENOMNI_WS_TOKEN?.trim();
  const machines = machinesFromEnv(home);
  const actors = actorsFromEnv();
  const socialBudgets = socialBudgetsFromEnv();
  const channelAllowedSenders = channelAllowedSendersFromEnv();
  return {
    dbPath: process.env.OPENOMNI_DB_PATH?.trim() || join(home, ".openomni", "storage.db"),
    host,
    wsPort: parseWsPort(process.env.OPENOMNI_WS_PORT),
    compactionSummarizer: compactionSummarizerFromEnv(),
    ...(wsToken === undefined || wsToken.length === 0 ? {} : { wsToken }),
    model: modelFromEnv(),
    ...(machines === undefined ? {} : { machines }),
    ...(actors === undefined ? {} : { actors }),
    ...(socialBudgets === undefined ? {} : { socialBudgets }),
    ...(channelAllowedSenders === undefined ? {} : { channelAllowedSenders }),
  };
}
