import { z } from "zod";
import { join } from "path";
import { homedir } from "os";
import { lazy } from "../util/lazy";

const DEFAULT_CACHE_DIR = join(homedir(), ".openomni");
const DEFAULT_CACHE_PATH = join(DEFAULT_CACHE_DIR, "models.json");

export namespace ModelsDev {
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
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  });
  export type Model = z.infer<typeof Model>;

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), z.any()),
  });
  export type Provider = z.infer<typeof Provider>;

  function modelsUrl() {
    return process.env.OPENOMNI_MODELS_URL || "https://models.dev";
  }

  function buildFallback(): Record<string, Provider> {
    return {};
  }

  async function writeCache(data: Record<string, Provider>): Promise<void> {
    try {
      const { mkdirSync } = await import("fs");
      const cachePath = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
      const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
      mkdirSync(cacheDir, { recursive: true });
      await Bun.write(cachePath, JSON.stringify(data));
    } catch {
      /* non-fatal */
    }
  }

  export const Data = lazy(async (): Promise<Record<string, Provider>> => {
    const cachePath = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
    const file = Bun.file(cachePath);
    const cached = await file.json().catch(() => undefined);
    if (cached) return cached as Record<string, Provider>;

    const snapshotModule =
      await import("../provider/models-snapshot.json").catch(() => undefined);
    if (snapshotModule?.default)
      return snapshotModule.default as Record<string, Provider>;

    if (process.env.OPENOMNI_DISABLE_MODELS_FETCH) return buildFallback();

    try {
      const response = await fetch(`${modelsUrl()}/api.json`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = (await response.json()) as Record<string, Provider>;
        await writeCache(data);
        return data;
      }
    } catch {
      /* non-fatal */
    }

    return buildFallback();
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
        const data = (await response.json()) as Record<string, Provider>;
        await writeCache(data);
        Data.reset();
      }
    } catch {
      /* non-fatal */
    }
  }

  let initialized = false;

  export function init(): void {
    if (initialized) return;
    initialized = true;

    if (!process.env.OPENOMNI_DISABLE_MODELS_FETCH) {
      ModelsDev.refresh();
      setInterval(
        () => {
          ModelsDev.refresh();
        },
        60 * 60 * 1000,
      ).unref();
    }
  }
}
