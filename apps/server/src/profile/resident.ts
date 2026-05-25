import { existsSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResidentAgent } from "@openomni/openomni";
import type { AgentDefinition, AgentFactory, AgentPromptMetadata } from "../agents/types";

const defaultProfileDir = path.join(os.homedir(), ".openomni", "profile");

export interface ResidentProfileOptions {
  readonly profileDir?: string;
  readonly model: AgentDefinition["model"];
}

export interface ResidentProfile {
  readonly factory: AgentFactory;
  readonly metadata: AgentPromptMetadata;
  readonly close: () => void;
}

interface ProfileSnapshot {
  readonly soul?: string;
  readonly memory?: string;
  readonly user?: string;
  readonly config: ResidentProfileConfig;
}

interface ResidentProfileConfig {
  readonly name?: string;
  readonly description?: string;
  readonly maxTurns?: number;
}

export async function createResidentProfile(
  options: ResidentProfileOptions,
): Promise<ResidentProfile> {
  const profileDir = options.profileDir ?? process.env.OPENOMNI_PROFILE_DIR ?? defaultProfileDir;
  let snapshot = await loadSnapshot(profileDir);
  let reload: Promise<void> | undefined;
  const watchers: FSWatcher[] = [];

  const scheduleReload = () => {
    if (reload) {
      return;
    }
    reload = loadSnapshot(profileDir)
      .then((next) => {
        snapshot = next;
      })
      .catch(() => undefined)
      .finally(() => {
        reload = undefined;
      });
  };

  try {
    watchers.push(...createWatchers(profileDir, scheduleReload));
  } catch (err) {
    console.warn(
      `[resident-profile] failed to create file watchers for ${profileDir}, live reload disabled`,
      err,
    );
    watchers.length = 0;
  }

  return {
    metadata: {
      name: "resident",
      description: snapshot.config.description ?? "Local Resident profile",
    },
    factory: () => ({
      name: "resident",
      description: snapshot.config.description ?? "Local Resident profile",
      model: options.model,
      systemPrompt: renderPrompt(snapshot, options.model),
      tools: { categories: ["custom"] },
      budget: { maxTurns: snapshot.config.maxTurns ?? 20 },
    }),
    close: () => {
      for (const watcher of watchers) watcher.close();
    },
  };
}

function createWatchers(profileDir: string, listener: () => void): FSWatcher[] {
  const paths = [profileDir, "SOUL.md", "USER.md", "MEMORY.md", "config.yaml"].map((entry) =>
    entry === profileDir ? entry : path.join(profileDir, entry),
  );
  const watchers: FSWatcher[] = [];
  for (const watchPath of paths) {
    if (watchPath !== profileDir && !existsSync(watchPath)) continue;
    watchers.push(watch(watchPath, { persistent: false }, listener));
  }
  return watchers;
}

async function loadSnapshot(profileDir: string): Promise<ProfileSnapshot> {
  return {
    soul: await optionalText(path.join(profileDir, "SOUL.md")),
    config: await optionalConfig(path.join(profileDir, "config.yaml")),
    ...(await optionalText(path.join(profileDir, "USER.md")).then((user) =>
      user ? { user } : {},
    )),
    ...(await optionalText(path.join(profileDir, "MEMORY.md")).then((memory) =>
      memory ? { memory } : {},
    )),
  };
}

async function optionalText(filePath: string): Promise<string | undefined> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return undefined;
  const text = (await file.text()).trim();
  return text || undefined;
}

async function optionalConfig(filePath: string): Promise<ResidentProfileConfig> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return {};
  const text = (await file.text()).trim();
  if (!text) return {};
  return parseResidentConfig(text, filePath);
}

function parseResidentConfig(text: string, filePath: string): ResidentProfileConfig {
  const config: {
    name?: string;
    description?: string;
    maxTurns?: number;
  } = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0)
      throw new Error(`invalid resident profile config line in ${filePath}: ${line}`);
    const key = trimmed.slice(0, separator).trim();
    const value = stripYamlString(trimmed.slice(separator + 1).trim());
    if (key === "name") config.name = value;
    if (key === "description") config.description = value;
    if (key === "maxTurns") config.maxTurns = parseMaxTurns(value, filePath);
  }
  return config;
}

function stripYamlString(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseMaxTurns(value: string, filePath: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`resident profile config maxTurns must be a positive integer: ${filePath}`);
  }
  return parsed;
}

function renderPrompt(snapshot: ProfileSnapshot, model: AgentDefinition["model"]): string {
  const base = ResidentAgent.getPrompt({ model });

  return [
    base,
    snapshot.soul ? `\n## Soul\n${snapshot.soul}` : undefined,
    renderConfig(snapshot.config),
    snapshot.user ? `\n## User\n${snapshot.user}` : undefined,
    snapshot.memory ? `\n## Memory\n${snapshot.memory}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function renderConfig(config: ResidentProfileConfig): string | undefined {
  const lines = [config.name ? `Name: ${config.name}` : undefined].filter((line): line is string =>
    Boolean(line),
  );
  return lines.length > 0 ? `\n## Profile\n${lines.join("\n")}` : undefined;
}
