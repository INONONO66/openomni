import type { Provider } from "./index";

type CacheEntry = {
  readonly expiresAt: number;
  readonly ids: string[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const modelCache = new Map<string, CacheEntry>();

function normalizeModelsURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/u, "");
  const root = trimmed.replace(/\/v1$/u, "");
  return `${root}/v1/models`;
}

function readModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !("data" in value)) return [];
  const data = value.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (typeof item !== "object" || item === null || !("id" in item)) return undefined;
      return typeof item.id === "string" ? item.id : undefined;
    })
    .filter((id): id is string => Boolean(id));
}

export async function fetchProxyModels(baseURL: string, apiKey?: string): Promise<string[]> {
  const url = normalizeModelsURL(baseURL);
  const cached = modelCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.ids;

  try {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, { headers });
    if (!response.ok) return [];
    const ids = readModelIds(await response.json());
    modelCache.set(url, { ids, expiresAt: Date.now() + CACHE_TTL_MS });
    return ids;
  } catch {
    return [];
  }
}

export function enrichWithCatalog(
  proxyModelIds: string[],
  catalogModels: Record<string, Provider.Model>,
  providerID: string,
): Provider.Model[] {
  return proxyModelIds.map((id) =>
    catalogModels[id]
      ? catalogModels[id]
      : {
          id,
          providerID,
          name: id,
          status: "active",
        },
  );
}
