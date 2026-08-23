import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenOmniConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly wsPort: number;
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

export function loadConfig(): OpenOmniConfig {
  return {
    dbPath: process.env.OPENOMNI_DB_PATH?.trim() || join(homedir(), ".openomni", "storage.db"),
    host: process.env.OPENOMNI_WS_HOST?.trim() || "127.0.0.1",
    wsPort: portFromEnv(),
    model: {
      provider: required("OPENOMNI_MODEL_PROVIDER"),
      id: required("OPENOMNI_MODEL_ID"),
      apiKey: required("OPENOMNI_MODEL_API_KEY"),
    },
  };
}
