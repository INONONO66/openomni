import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { z } from "zod";

function getConfigPath(): string {
  return process.env.OPENOMNI_CONFIG_PATH ?? join(homedir(), ".openomni", "config.json");
}

const AdaptersSchema = z
  .object({
    telegram: z
      .object({
        token: z.string(),
        allowedUsers: z.string().array().optional(),
      })
      .optional(),
    github: z
      .object({
        secret: z.string(),
        token: z.string().optional(),
        botUsername: z.string().optional(),
        allowedUsers: z.string().array().optional(),
      })
      .optional(),
    discord: z
      .object({
        token: z.string(),
        allowedUsers: z.string().array().optional(),
      })
      .optional(),
  })
  .passthrough();

export namespace Config {
  export interface TelegramConfig {
    token: string;
    allowedUsers?: string[];
  }

  export interface GitHubConfig {
    secret: string;
    token?: string;
    botUsername?: string;
    allowedUsers?: string[];
  }

  export interface DiscordConfig {
    token: string;
    allowedUsers?: string[];
  }

  export interface Adapters {
    telegram?: TelegramConfig;
    github?: GitHubConfig;
    discord?: DiscordConfig;
  }

  export function load(): Adapters {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      const result = AdaptersSchema.safeParse(parsed);
      if (!result.success) {
        console.warn("[config] invalid config.json, ignoring:", result.error.message);
        return {};
      }
      return result.data;
    } catch (err) {
      console.warn(
        "[config] failed to read config.json:",
        err instanceof Error ? err.message : err,
      );
      return {};
    }
  }

  export function save(config: Adapters): void {
    const configPath = getConfigPath();
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    secureFile(configPath);
  }

  export function setAdapter<K extends keyof Adapters>(
    adapter: K,
    value: NonNullable<Adapters[K]>,
  ): void {
    const config = load();
    config[adapter] = value;
    save(config);
  }

  export function removeAdapter(adapter: keyof Adapters): boolean {
    const config = load();
    if (!(adapter in config)) return false;
    delete config[adapter];
    save(config);
    return true;
  }

  /** Mask a secret for display: show last 4 chars only. */
  export function mask(value: string): string {
    if (value.length <= 4) return "••••";
    return `••••${value.slice(-4)}`;
  }

  /** Secure sensitive files to owner-only read/write (0600). */
  export function secureFile(filePath: string): void {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // chmod may not be supported (e.g., Windows) — best-effort
    }
  }

  /** Secure all sensitive files in ~/.openomni/ on boot. */
  export function secureAll(): void {
    const dir = join(homedir(), ".openomni");
    const sensitiveFiles = ["config.json", "auth.json"];
    for (const file of sensitiveFiles) {
      const path = join(dir, file);
      if (existsSync(path)) secureFile(path);
    }
  }
}
