import type { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { Model as ProtocolModel } from "@openomni/protocol";
const DEFAULT_CACHE_DIR = join(homedir(), ".openomni");
const DEFAULT_CACHE_PATH = join(DEFAULT_CACHE_DIR, "models.json");
const TRUSTED_REMOTE_PROVIDER_PACKAGES = new Set(["@ai-sdk/anthropic", "@ai-sdk/openai"]);

export namespace ModelsDev {
  export const ModelStatus = ProtocolModel.Status;
  export type ModelStatus = z.infer<typeof ModelStatus>;

  export interface Model {
    id: string;
    name: string;
    family?: string;
    release_date?: string;
    limit?: { context: number };
    status?: ModelStatus;
    provider?: { npm: string };
  }

  export interface Provider {
    api?: string;
    name: string;
    env: string[];
    id: string;
    npm?: string;
    models: Record<string, unknown>;
  }

  function modelsUrl() {
    return process.env.OPENOMNI_MODELS_URL || "https://models.dev";
  }

  async function writeCache(data: Record<string, Provider>): Promise<void> {
    try {
      const { mkdirSync } = await import("node:fs");
      const cachePath = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
      const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
      mkdirSync(cacheDir, { recursive: true });
      await Bun.write(cachePath, JSON.stringify(data));
    } catch {
      /* non-fatal */
    }
  }

  function sanitizeRemoteCatalog(data: unknown): Record<string, Provider> {
    const sanitized = Object.create(null) as Record<string, Provider>;
    if (!isRecord(data)) return sanitized;

    for (const [providerID, rawProvider] of Object.entries(data)) {
      if (isPrototypeKey(providerID)) continue;
      if (!isRecord(rawProvider)) continue;
      const provider = rawProvider as Partial<Provider>;
      if (typeof provider.npm !== "string" || !TRUSTED_REMOTE_PROVIDER_PACKAGES.has(provider.npm)) {
        continue;
      }
      if (typeof provider.name !== "string" || !Array.isArray(provider.env)) continue;
      const { api: _api, ...rest } = provider;
      sanitized[providerID] = {
        id: typeof rest.id === "string" ? rest.id : providerID,
        name: provider.name,
        env: provider.env.filter((entry): entry is string => typeof entry === "string"),
        npm: provider.npm,
        models: sanitizeRemoteModels(provider.models),
      };
    }
    return sanitized;
  }

  function sanitizeRemoteModels(models: unknown): Record<string, unknown> {
    const sanitized = Object.create(null) as Record<string, unknown>;
    if (!isRecord(models)) return sanitized;

    for (const [modelID, rawModel] of Object.entries(models)) {
      if (isPrototypeKey(modelID)) continue;
      if (!isRecord(rawModel)) continue;
      const { provider: _provider, ...rest } = rawModel as Record<string, unknown>;
      if (typeof rest.id !== "string" || typeof rest.name !== "string") continue;
      sanitized[modelID] = rest;
    }
    return sanitized;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isPrototypeKey(key: string): boolean {
    return key === "__proto__" || key === "constructor" || key === "prototype";
  }

  export const Data = lazy(async (): Promise<Record<string, Provider>> => {
    const cachePath = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
    const file = Bun.file(cachePath);
    const cached = await file.json().catch(() => undefined);
    if (cached) return sanitizeRemoteCatalog(cached);

    if (!process.env.OPENOMNI_DISABLE_MODELS_FETCH) {
      try {
        const response = await fetch(`${modelsUrl()}/api.json`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const data = sanitizeRemoteCatalog(await response.json());
          await writeCache(data);
          return data;
        }
      } catch {
        /* non-fatal */
      }
    }

    const snapshotModule = await import("./models-snapshot.json");
    return snapshotModule.default as Record<string, Provider>;
  });

  // The on-disk catalog cache is write-once by design: it is populated on the
  // first fetch and never refreshed afterwards (delete the file to refetch).
  // A refresh() existed but had zero production callers, so it was removed
  // rather than kept as unwired surface.
  export async function get(): Promise<Record<string, Provider>> {
    return Data() as Promise<Record<string, Provider>>;
  }
}

function lazy<T>(fn: () => T) {
  let value: T | undefined;
  let loaded = false;

  const result = (): T => {
    if (loaded) return value as T;
    loaded = true;
    value = fn();
    return value as T;
  };

  result.reset = () => {
    loaded = false;
    value = undefined;
  };

  return result;
}
