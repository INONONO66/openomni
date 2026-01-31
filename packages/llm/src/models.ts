import { z } from "zod";
import { join } from "path";
import { homedir } from "os";
import { ANTHROPIC_MODELS } from "./provider/anthropic";
import { OPENAI_MODELS } from "./provider/openai";

const DEFAULT_CACHE_DIR = join(homedir(), ".openomni");
const DEFAULT_CACHE_PATH = join(DEFAULT_CACHE_DIR, "models.json");
const API_URL = "https://models.dev/api.json";

export namespace ModelsDev {
  export const Model = z.object({
    id: z.string(),
    name: z.string(),
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
    capabilities: z
      .object({
        vision: z.boolean().optional(),
        thinking: z.boolean().optional(),
        tools: z.boolean().optional(),
        reasoning: z.boolean().optional(),
      })
      .optional(),
    modalities: z
      .object({
        input: z.array(z.string()),
        output: z.array(z.string()),
      })
      .optional(),
  });
  export type Model = z.infer<typeof Model>;

  export const Provider = z.object({
    id: z.string(),
    name: z.string(),
    env: z.array(z.string()),
    npm: z.string().optional(),
    models: z.record(z.string(), z.any()),
  });
  export type Provider = z.infer<typeof Provider>;

  let _cache: Record<string, Provider> | null = null;
  let _cachePath = DEFAULT_CACHE_PATH;
  let _cacheDir = DEFAULT_CACHE_DIR;

  export function _setCachePath(dir: string, path: string) {
    _cacheDir = dir;
    _cachePath = path;
  }

  function buildFallback(): Record<string, Provider> {
    const anthropicModels: Record<string, unknown> = {};
    for (const m of ANTHROPIC_MODELS) {
      anthropicModels[m.id] = {
        id: m.id,
        name: m.name,
        capabilities: m.capabilities,
      };
    }

    const openaiModels: Record<string, unknown> = {};
    for (const m of OPENAI_MODELS) {
      openaiModels[m.id] = {
        id: m.id,
        name: m.name,
        cost: m.cost,
      };
    }

    return {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        models: anthropicModels,
      },
      openai: {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        models: openaiModels,
      },
    };
  }

  async function readCache(): Promise<Record<string, Provider> | null> {
    try {
      const file = Bun.file(_cachePath);
      if (await file.exists()) {
        return (await file.json()) as Record<string, Provider>;
      }
    } catch {
      /* cache miss */
    }
    return null;
  }

  async function writeCache(data: Record<string, Provider>): Promise<void> {
    try {
      const { mkdirSync } = await import("fs");
      mkdirSync(_cacheDir, { recursive: true });
      await Bun.write(_cachePath, JSON.stringify(data));
    } catch {
      /* non-fatal */
    }
  }

  async function fetchFromApi(): Promise<Record<string, Provider> | null> {
    try {
      const response = await fetch(API_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const json = await response.json();
      return json as Record<string, Provider>;
    } catch {
      return null;
    }
  }

  export async function get(): Promise<Record<string, Provider>> {
    if (_cache) return _cache;

    const cached = await readCache();
    if (cached) {
      _cache = cached;
      return _cache;
    }

    const fetched = await fetchFromApi();
    if (fetched) {
      _cache = fetched;
      await writeCache(fetched);
      return _cache;
    }

    _cache = buildFallback();
    return _cache;
  }

  export const Data = Object.assign(get, {
    reset() {
      _cache = null;
    },
  });

  export async function refresh(): Promise<void> {
    const fetched = await fetchFromApi();
    if (fetched) {
      _cache = fetched;
      await writeCache(fetched);
    }
  }

  export function _resetCache() {
    _cache = null;
  }
}
