import { homedir } from "node:os";
import { join } from "node:path";
import { Actor, Machine } from "@openomni/protocol";
import { z } from "zod";

export interface OpenOmniConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly wsPort: number;
  /** Required for non-loopback hosts; every ws sender is granted owner tier. */
  readonly wsToken?: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly apiKey: string;
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
}

export interface RegisteredActor {
  readonly actorId: string;
  /** The identity the actor's connection declares (`?actor=<externalId>`). */
  readonly externalId: string;
  readonly trustTier: Actor.TrustTier;
  readonly kind: Actor.Kind;
  readonly displayName?: string;
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

const Enrollments = z.array(Machine.Enrollment).min(1);

const Actors = z
  .array(
    z
      .object({
        actorId: z.string().min(1),
        externalId: z.string().min(1),
        trustTier: Actor.TrustTier,
        kind: Actor.Kind.default("human"),
        displayName: z.string().min(1).optional(),
      })
      .strict(),
  )
  .min(1);

/**
 * Like enrollment, actor admission is the Owner's decision read from config:
 * who may be delegated to is never inferred from whoever connects.
 */
function actorsFromEnv(): OpenOmniConfig["actors"] {
  const raw = process.env.OPENOMNI_ACTORS?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Actors.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`OPENOMNI_ACTORS is invalid: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

/**
 * Enrollment is the Owner's admission decision, so it is read from config
 * rather than inferred from whoever connects. Ledger-backed enrollment is a
 * later slice; the shape the host consumes is already the protocol's.
 */
function machinesFromEnv(): OpenOmniConfig["machines"] {
  const raw = process.env.OPENOMNI_MACHINES_ENROLLED?.trim();
  if (raw === undefined || raw.length === 0) return undefined;

  const parsed = Enrollments.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`OPENOMNI_MACHINES_ENROLLED is invalid: ${parsed.error.issues[0]?.message}`);
  }
  return {
    socketPath:
      process.env.OPENOMNI_MACHINES_SOCKET?.trim() || join(homedir(), ".openomni", "machines.sock"),
    enrolled: parsed.data,
  };
}

export function loadConfig(): OpenOmniConfig {
  const host = process.env.OPENOMNI_WS_HOST?.trim() || "127.0.0.1";
  const wsToken = process.env.OPENOMNI_WS_TOKEN?.trim();
  const machines = machinesFromEnv();
  const actors = actorsFromEnv();
  return {
    dbPath: process.env.OPENOMNI_DB_PATH?.trim() || join(homedir(), ".openomni", "storage.db"),
    host,
    wsPort: portFromEnv(),
    ...(wsToken === undefined || wsToken.length === 0 ? {} : { wsToken }),
    model: {
      provider: required("OPENOMNI_MODEL_PROVIDER"),
      id: required("OPENOMNI_MODEL_ID"),
      apiKey: required("OPENOMNI_MODEL_API_KEY"),
    },
    ...(machines === undefined ? {} : { machines }),
    ...(actors === undefined ? {} : { actors }),
  };
}
