import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Catalog, RemoteCatalog } from "./schema";

const DEFAULT_CACHE_PATH = join(homedir(), ".openomni", "models.json");

async function snapshot(): Promise<Catalog> {
  return Catalog.parse((await import("./models-snapshot.json")).default);
}

async function loadCatalog(loadSnapshot: () => Promise<Catalog>): Promise<Catalog> {
  const path = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
  const cached = RemoteCatalog.parse(await Bun.file(path).json().catch(() => undefined));
  if (Object.keys(cached).length > 0) return cached;

  if (!process.env.OPENOMNI_DISABLE_MODELS_FETCH) {
    try {
      const response = await fetch(`${process.env.OPENOMNI_MODELS_URL || "https://models.dev"}/api.json`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = RemoteCatalog.parse(await response.json());
        // Cache persistence is optional; a successful response remains usable.
        try {
          await mkdir(dirname(path), { recursive: true });
          await Bun.write(path, JSON.stringify(data));
        } catch {
          return data;
        }
        return data;
      }
    } catch {
      return loadSnapshot();
    }
  }
  return loadSnapshot();
}

/** Each owner gets one lazy catalog; tests replace the owner rather than shipping a reset API. */
export function createCatalogLoader(loadSnapshot: () => Promise<Catalog> = snapshot): () => Promise<Catalog> {
  let loaded: Promise<Catalog> | undefined;
  return () => {
    loaded ??= loadCatalog(loadSnapshot);
    return loaded;
  };
}
