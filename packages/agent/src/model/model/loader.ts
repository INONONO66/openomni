import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Semaphore } from "effect";
import { decodeLlmFailure } from "../error";
import type { LlmError } from "../errors";
import { Catalog, RemoteCatalog } from "./schema";

const DEFAULT_CACHE_PATH = join(homedir(), ".openomni", "models.json");

/**
 * The llm package's one environment owner (#1245): the credential file
 * location is resolved here, in the model loading Layer, and injected into
 * `auth/storage`, which performs no environment reads of its own.
 */
export function resolveAuthFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env.OPENOMNI_AUTH_FILE;
  return override ? resolve(override) : join(homedir(), ".openomni", "auth.json");
}
async function snapshot(): Promise<Catalog> {
  return Catalog.parse((await import("./models-snapshot.json")).default);
}
function loadCatalog(loadSnapshot: () => Promise<Catalog>): Effect.Effect<Catalog, LlmError> {
  return Effect.gen(function* () {
    const path = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
    const cached = yield* Effect.tryPromise({ try: () => Bun.file(path).json(), catch: decodeLlmFailure("catalog.cache.read") }).pipe(
      Effect.map(RemoteCatalog.parse), Effect.catch(() => Effect.succeed({})),
    );
    if (Object.keys(cached).length > 0) return cached;
    if (!process.env.OPENOMNI_DISABLE_MODELS_FETCH) {
      const remote = yield* Effect.tryPromise({
        try: (signal) => fetch(`${process.env.OPENOMNI_MODELS_URL || "https://models.dev"}/api.json`, { signal }),
        catch: decodeLlmFailure("catalog.fetch"),
      }).pipe(Effect.timeoutOption(10_000), Effect.flatMap((response) => {
        if (response._tag === "None" || !response.value.ok) return Effect.succeed(undefined);
        return Effect.tryPromise({ try: () => response.value.json(), catch: decodeLlmFailure("catalog.json") }).pipe(Effect.map(RemoteCatalog.parse));
      }), Effect.catch(() => Effect.succeed(undefined)));
      if (remote !== undefined) {
        yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: decodeLlmFailure("catalog.cache.mkdir") }).pipe(
          Effect.andThen(Effect.tryPromise({ try: () => Bun.write(path, JSON.stringify(remote)), catch: decodeLlmFailure("catalog.cache.write") })),
          Effect.catch(() => Effect.void),
        );
        return remote;
      }
    }
    return yield* Effect.tryPromise({ try: loadSnapshot, catch: decodeLlmFailure("catalog.snapshot") });
  });
}
/** Each owner lazily loads one catalog, including concurrent requests. */
export function createCatalogLoader(loadSnapshot: () => Promise<Catalog> = snapshot): () => Effect.Effect<Catalog, LlmError> {
  let loaded: Catalog | undefined;
  const lock = Semaphore.makeUnsafe(1);
  return () => lock.withPermits(1)(Effect.suspend(() => loaded === undefined
    ? loadCatalog(loadSnapshot).pipe(Effect.tap((catalog) => Effect.sync(() => { loaded = catalog; })))
    : Effect.succeed(loaded)));
}
