import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

const DEFAULT_SECRETS_PATH = join(homedir(), ".openomni", "secrets.json");

export type Credentials = Record<string, string>;

export function loadCredentials(path = DEFAULT_SECRETS_PATH): Credentials {
  if (!existsSync(path)) return {};
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as Credentials;
  } catch (error) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "coordinator.credentials",
      msg: `failed to load credentials from ${path}`,
      context: { error: error instanceof Error ? error.message : String(error) },
    });
    return {};
  }
}

export function getCredentialsForProvider(
  creds: Credentials,
  provider: string,
): Record<string, string> {
  const prefix = provider.toUpperCase().replace(/-/g, "_");
  return Object.fromEntries(Object.entries(creds).filter(([k]) => k.startsWith(prefix)));
}
