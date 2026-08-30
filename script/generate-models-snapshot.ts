#!/usr/bin/env bun
// Fetch the models.dev catalog and retain only metadata consumed by @openomni/llm.
export {};

const MODELS_URL = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";
const BUNDLED_PROVIDERS = ["anthropic", "openai"] as const;
const SNAPSHOT_PATH = "packages/llm/src/model/models-snapshot.json";

const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) {
  console.error(`[generate-models-snapshot] ${MODELS_URL} → ${response.status}`);
  process.exit(1);
}

const catalog = (await response.json()) as Record<string, Record<string, unknown>>;
const subset: Record<string, unknown> = {};
for (const providerID of BUNDLED_PROVIDERS) {
  const provider = catalog[providerID];
  if (!provider || typeof provider.models !== "object" || provider.models === null) {
    console.error(
      `[generate-models-snapshot] provider missing or has no models in catalog: ${providerID}`,
    );
    process.exit(1);
  }
  const models: Record<string, unknown> = {};
  for (const [modelID, rawModel] of Object.entries(
    provider.models as Record<string, Record<string, unknown>>,
  )) {
    models[modelID] = projectModel(rawModel);
  }
  subset[providerID] = {
    id: provider.id,
    name: provider.name,
    env: provider.env,
    npm: provider.npm,
    ...(provider.api === undefined ? {} : { api: provider.api }),
    models,
  };
}

await Bun.write(SNAPSHOT_PATH, `${JSON.stringify(subset, null, 2)}\n`);
console.log(
  `[generate-models-snapshot] wrote ${SNAPSHOT_PATH} (${BUNDLED_PROVIDERS.length} providers)`,
);

function projectModel(model: Record<string, unknown>): Record<string, unknown> {
  const limit = model.limit as Record<string, unknown> | undefined;
  const provider = model.provider as Record<string, unknown> | undefined;
  return {
    id: model.id,
    name: model.name,
    ...(model.family === undefined ? {} : { family: model.family }),
    ...(model.release_date === undefined ? {} : { release_date: model.release_date }),
    ...(model.status === undefined ? {} : { status: model.status }),
    ...(limit?.context === undefined ? {} : { limit: { context: limit.context } }),
    ...(provider?.npm === undefined ? {} : { provider: { npm: provider.npm } }),
  };
}
