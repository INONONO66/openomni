import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { decodeLlmFailure } from "../error";
import type { LlmError } from "../errors";
import { Catalog, RemoteCatalog } from "./schema";

const DEFAULT_CACHE_PATH = join(homedir(), ".openomni", "models.json");
async function snapshot(): Promise<Catalog> {
  return Catalog.parse((await import("./models-snapshot.json")).default);
}
function loadCatalog(loadSnapshot: () => Promise<Catalog>): Effect.Effect<Catalog, LlmError> {
  return Effect.gen(function* () {
    const path = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
    const cached = yield* Effect.tryPromise({ try: () => Bun.file(path).json(), catch: decodeLlmFailure("catalog.cache.read") }).pipe(
      Effect.map(RemoteCatalog.parse), Effect.catchAll(() => Effect.succeed({})),
    );
    if (Object.keys(cached).length > 0) return cached;
    if (!process.env.OPENOMNI_DISABLE_MODELS_FETCH) {
      const remote = yield* Effect.tryPromise({
        try: (signal) => fetch(`${process.env.OPENOMNI_MODELS_URL || "https://models.dev"}/api.json`, { signal }),
        catch: decodeLlmFailure("catalog.fetch"),
      }).pipe(Effect.timeoutOption(10_000), Effect.flatMap((response) => {
        if (response._tag === "None" || !response.value.ok) return Effect.succeed(undefined);
        return Effect.tryPromise({ try: () => response.value.json(), catch: decodeLlmFailure("catalog.json") }).pipe(Effect.map(RemoteCatalog.parse));
      }), Effect.catchAll(() => Effect.succeed(undefined)));
      if (remote !== undefined) {
        yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: decodeLlmFailure("catalog.cache.mkdir") }).pipe(
          Effect.zipRight(Effect.tryPromise({ try: () => Bun.write(path, JSON.stringify(remote)), catch: decodeLlmFailure("catalog.cache.write") })),
          Effect.catchAll(() => Effect.void),
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
  const lock = Effect.unsafeMakeSemaphore(1);
  return () => lock.withPermits(1)(Effect.suspend(() => loaded === undefined
    ? loadCatalog(loadSnapshot).pipe(Effect.tap((catalog) => Effect.sync(() => { loaded = catalog; })))
    : Effect.succeed(loaded)));
}
