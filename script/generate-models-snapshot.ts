#!/usr/bin/env bun
// Fetch the models.dev catalog, narrow it to the providers bundled with
// @openomni/llm, and write the result to packages/llm/src/provider/models-snapshot.json.
//
// The snapshot is the second rung of ModelsDev.get()'s fallback chain (user
// cache → this snapshot → live fetch → empty). Keeping it fresh avoids silent
// downgrades in fresh installs and CI runs where neither the cache nor
// models.dev is reachable.

const MODELS_URL = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";
const BUNDLED_PROVIDERS = ["anthropic", "openai"] as const;
const SNAPSHOT_PATH = "packages/llm/src/provider/models-snapshot.json";

const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) {
  console.error(`[generate-models-snapshot] ${MODELS_URL} → ${response.status}`);
  process.exit(1);
}

const catalog = (await response.json()) as Record<string, unknown>;
const subset: Record<string, unknown> = {};
for (const providerID of BUNDLED_PROVIDERS) {
  const entry = catalog[providerID];
  if (!entry) {
    console.error(`[generate-models-snapshot] provider missing from catalog: ${providerID}`);
    process.exit(1);
  }
  subset[providerID] = entry;
}

await Bun.write(SNAPSHOT_PATH, `${JSON.stringify(subset, null, 2)}\n`);
console.log(
  `[generate-models-snapshot] wrote ${SNAPSHOT_PATH} (${BUNDLED_PROVIDERS.length} providers)`,
);
