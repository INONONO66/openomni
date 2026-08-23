import { homedir } from "node:os";
import { join } from "node:path";

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

export function loadConfig(): OpenOmniConfig {
  const host = process.env.OPENOMNI_WS_HOST?.trim() || "127.0.0.1";
  const wsToken = process.env.OPENOMNI_WS_TOKEN?.trim();
  // The gateway grants every ws sender owner tier (src/gateway.ts), so a
  // non-loopback bind without upgrade authentication would expose owner-tier
  // ingress to the network. Fail closed here — the single enforcement layer
  // for this invariant.
  if (!LOOPBACK_HOSTS.has(host) && (wsToken === undefined || wsToken.length === 0)) {
    throw new Error("OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback");
  }
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
  };
}
