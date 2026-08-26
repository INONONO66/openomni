import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The one durable CLI-owned config surface: `~/.openomni/env`. Onboarding
 * writes it, `openomni start` reads it back into the process environment,
 * and `loadConfig` stays env-only — no second config format exists.
 */
export interface EnvEntry {
  readonly key: string;
  readonly value: string;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** KEY=VALUE lines; blank lines and `#` comments skipped; last duplicate wins. */
export function parseEnvFile(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;
    entries.set(key, unquote(trimmed.slice(separator + 1).trim()));
  }
  return entries;
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

export function renderEnvFile(entries: readonly EnvEntry[]): string {
  const lines = entries.map((entry) => {
    if (!KEY_PATTERN.test(entry.key)) {
      throw new Error(`invalid env key: ${entry.key}`);
    }
    if (/[\n\r]/.test(entry.value)) {
      throw new Error(`env value for ${entry.key} must not contain line breaks`);
    }
    return `${entry.key}=${entry.value}`;
  });
  return `${lines.join("\n")}\n`;
}

/** Secrets file: created and kept at 0600 even when overwriting an existing file. */
export function writeEnvFile(path: string, entries: readonly EnvEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderEnvFile(entries), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Loads the env file into `env` without overriding keys the process already
 * has — an explicit `OPENOMNI_*` export always beats the file. A missing
 * file is not an error: `openomni start` with a fully exported environment
 * is a supported shape.
 */
export function applyEnvFile(path: string, env: Record<string, string | undefined>): void {
  if (!existsSync(path)) return;
  for (const [key, value] of parseEnvFile(readFileSync(path, "utf-8"))) {
    if (env[key] === undefined) env[key] = value;
  }
}
