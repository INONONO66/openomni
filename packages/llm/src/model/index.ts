import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { Model as ProtocolModel } from "@openomni/protocol";
const DEFAULT_CACHE_DIR = join(homedir(), ".openomni");
const DEFAULT_CACHE_PATH = join(DEFAULT_CACHE_DIR, "models.json");
const TRUSTED_REMOTE_PROVIDER_PACKAGES = new Set(["@ai-sdk/anthropic", "@ai-sdk/openai"]);

export namespace ModelsDev {
  export const ModelStatus = ProtocolModel.Status;
  export type ModelStatus = z.infer<typeof ModelStatus>;

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string().optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    temperature: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
      })
      .optional(),
    limit: z
      .object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      })
      .optional(),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    status: ModelStatus.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string() }).optional(),
  });
  export type Model = z.infer<typeof Model>;

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), z.unknown()),
  });
  export type Provider = z.infer<typeof Provider>;

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

    const snapshotModule = await import("./models-snapshot.json").catch(() => undefined);
    if (snapshotModule?.default) return snapshotModule.default as Record<string, Provider>;

    return {};
  });

  export async function get(): Promise<Record<string, Provider>> {
    return Data() as Promise<Record<string, Provider>>;
  }

  export async function refresh(): Promise<void> {
    try {
      const response = await fetch(`${modelsUrl()}/api.json`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = sanitizeRemoteCatalog(await response.json());
        await writeCache(data);
        Data.reset();
      }
    } catch {
      /* non-fatal */
    }
  }
}

// merged from util/lazy.ts (#453 hygiene: sub-30-LOC single-importer)
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
