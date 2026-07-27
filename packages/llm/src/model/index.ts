import { Model as ProtocolModel } from "@openomni/protocol";
import { z } from "zod";
import snapshot from "./models-snapshot.json";
import {
  CatalogExternalFetchError,
  type CatalogCacheDependencies,
  type CatalogEnvironmentBinding,
  type LoadedCatalog,
  loadModelCatalog,
  nodeCatalogCacheFileSystem,
  sha256CatalogDigest,
} from "./catalog-cache";

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
        z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict(),
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
      .object({ context: z.number(), input: z.number().optional(), output: z.number() })
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
    variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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

  export const createService = createModelCatalogService;
}

export type ModelCatalogProvider = LoadedCatalog["catalog"][string];
export type ModelCatalogProviderInput = ModelsDev.Provider | ModelCatalogProvider;

export interface ModelCatalogService {
  /** Returns the current validated catalog and its immutable environment reference. */
  load(): Promise<LoadedCatalog>;
  get(): Promise<LoadedCatalog["catalog"]>;
}

export interface ModelCatalogServiceOptions {
  readonly cachePath: string;
  readonly environment: CatalogEnvironmentBinding;
  readonly remoteURL?: string;
  readonly offline?: boolean;
  readonly fetchDisabled?: boolean;
  readonly bundledVersion?: string;
  readonly dependencies?: Partial<CatalogCacheDependencies>;
}

/** Creates the sole mutable TTL owner. Catalog consumers receive frozen validated data only. */
export function createModelCatalogService(
  options: ModelCatalogServiceOptions,
): ModelCatalogService {
  const dependencies: CatalogCacheDependencies = {
    now: options.dependencies?.now ?? Date.now,
    digest: options.dependencies?.digest ?? sha256CatalogDigest,
    fs: options.dependencies?.fs ?? nodeCatalogCacheFileSystem(),
    tempName: options.dependencies?.tempName ?? (() => crypto.randomUUID()),
    fetchRemote:
      options.dependencies?.fetchRemote ??
      (async ({ timeoutMs }) => {
        if (!options.remoteURL) throw new Error("Remote model catalog URL is not configured");
        try {
          const response = await fetch(options.remoteURL, {
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            throw new Error(`Remote model catalog returned HTTP ${response.status}`);
          }
          return {
            catalog: await response.json(),
            version:
              response.headers.get("etag") ?? response.headers.get("last-modified") ?? "remote",
          };
        } catch (error) {
          throw new CatalogExternalFetchError(
            error instanceof Error ? error.message : "Remote model catalog fetch failed",
          );
        }
      }),
  };

  let inFlight: Promise<LoadedCatalog> | undefined;
  const load = (): Promise<LoadedCatalog> => {
    if (inFlight) return inFlight;
    const request = loadModelCatalog(
      {
        cachePath: options.cachePath,
        environment: options.environment,
        bundled: {
          catalog: snapshot,
          version: options.bundledVersion ?? "bundled",
        },
        offline: options.offline,
        fetchDisabled: options.fetchDisabled ?? options.remoteURL === undefined,
      },
      dependencies,
    );
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = undefined;
    };
    void request.then(clear, clear);
    return request;
  };

  return Object.freeze({
    load,
    async get() {
      return (await load()).catalog;
    },
  });
}
