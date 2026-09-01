import { z } from "zod";
import { NamedError } from "../error";
import type { Provider } from "./index";

/**
 * A proxy that cannot list its models must fail loudly: swallowing the
 * failure into an empty list made listModels() fall through to the full
 * models.dev catalog, presenting every model as "available on this proxy".
 */
export const ProxyModelsError = NamedError.create(
  "ProxyModelsError",
  z.object({
    message: z.string(),
    url: z.string(),
    status: z.number().optional(),
  }),
);

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

function credentialFingerprint(apiKey: string | undefined): string {
  return new Bun.CryptoHasher("sha256")
    .update(apiKey === undefined ? "no-api-key" : `api-key:${apiKey}`)
    .digest("hex");
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
  const cacheKey = `${url}:${credentialFingerprint(apiKey)}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.ids;

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (cause) {
    throw new ProxyModelsError(
      { message: `proxy model listing unreachable: ${String(cause)}`, url },
      { cause },
    );
  }
  if (!response.ok) {
    throw new ProxyModelsError({
      message: `proxy model listing returned HTTP ${response.status}`,
      url,
      status: response.status,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ProxyModelsError(
      { message: "proxy model listing returned invalid JSON", url },
      { cause },
    );
  }

  const ids = readModelIds(body);
  modelCache.set(cacheKey, { ids, expiresAt: Date.now() + CACHE_TTL_MS });
  return ids;
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
        },
  );
}
