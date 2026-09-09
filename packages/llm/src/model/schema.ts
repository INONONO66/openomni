import { z } from "zod";

export const CatalogModel = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  limit: z.object({ context: z.number() }).optional(),
  provider: z.object({ npm: z.string() }).optional(),
});

const PrototypeKey = new Set(["__proto__", "constructor", "prototype"]);
const RemoteModel = CatalogModel.omit({ provider: true }).optional().catch(undefined);
const RemoteProvider = z.object({
  id: z.string().optional(),
  name: z.string(),
  env: z.array(z.string().optional().catch(undefined)).transform((entries) => entries.filter((entry) => entry !== undefined)),
  npm: z.enum(["@ai-sdk/anthropic", "@ai-sdk/openai"]),
  models: z.record(z.string(), RemoteModel).catch({}).transform((models) =>
    Object.fromEntries(Object.entries(models).filter(([id, model]) => !PrototypeKey.has(id) && model !== undefined)),
  ),
});

export const CatalogProvider = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), CatalogModel),
});
export const Catalog = z.record(z.string(), CatalogProvider);
export type Catalog = z.infer<typeof Catalog>;

export const RemoteCatalog = z.record(z.string(), RemoteProvider.optional().catch(undefined)).catch({}).transform((providers): Catalog => {
  const result: Catalog = {};
  for (const [id, provider] of Object.entries(providers)) {
    if (PrototypeKey.has(id) || provider === undefined) continue;
    result[id] = CatalogProvider.parse({ ...provider, id: provider.id ?? id });
  }
  return result;
});
