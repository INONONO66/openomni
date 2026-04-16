import type { ChatAgentConfig } from "@openomni/agent";
import { Auth, Provider } from "@openomni/llm";

const DATE_SUFFIX_RE = /-\d{8}$/;

const statusOrder: Record<string, number> = {
  active: 0,
  beta: 1,
  alpha: 2,
  deprecated: 3,
};

type RuntimeModel = ChatAgentConfig["model"];
type CatalogModel = Provider.Model;

function isConcreteModelID(modelID: string): boolean {
  return DATE_SUFFIX_RE.test(modelID);
}

function normalizeName(name: string): string {
  return name
    .replace(/\s*\(latest\)\s*$/iu, "")
    .trim()
    .toLowerCase();
}

function compareModels(a: CatalogModel, b: CatalogModel): number {
  const releaseOrder = (b.release_date ?? "").localeCompare(a.release_date ?? "");
  if (releaseOrder !== 0) return releaseOrder;

  const statusDelta =
    (statusOrder[a.status ?? "active"] ?? 99) - (statusOrder[b.status ?? "active"] ?? 99);
  if (statusDelta !== 0) return statusDelta;

  return b.id.localeCompare(a.id);
}

function sortModels(models: CatalogModel[]): CatalogModel[] {
  return [...models].sort(compareModels);
}

function matchConcreteSiblings(preferredID: string, models: CatalogModel[]): CatalogModel[] {
  return sortModels(
    models.filter((model) => isConcreteModelID(model.id) && model.id.startsWith(`${preferredID}-`)),
  );
}

function inferFamily(preferredID: string, models: CatalogModel[]): string | undefined {
  return [
    ...new Set(
      models
        .map((model) => model.family)
        .filter((family): family is string => typeof family === "string" && family.length > 0),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .find((family) => preferredID === family || preferredID.startsWith(`${family}-`));
}

function findConcreteSibling(
  exact: CatalogModel,
  models: CatalogModel[],
): CatalogModel | undefined {
  let candidates = matchConcreteSiblings(exact.id, models);
  if (candidates.length === 0) return undefined;

  if (exact.family) {
    const familyMatches = candidates.filter((candidate) => candidate.family === exact.family);
    if (familyMatches.length > 0) candidates = familyMatches;
  }

  if (exact.release_date) {
    const releaseMatches = candidates.filter(
      (candidate) => candidate.release_date === exact.release_date,
    );
    if (releaseMatches.length > 0) candidates = releaseMatches;
  }

  const expectedName = normalizeName(exact.name);
  const nameMatches = candidates.filter(
    (candidate) => normalizeName(candidate.name) === expectedName,
  );
  if (nameMatches.length > 0) candidates = nameMatches;

  return sortModels(candidates)[0];
}

export function resolveCatalogModel(
  preferredID: string,
  models: CatalogModel[],
): CatalogModel | undefined {
  const exact = models.find((model) => model.id === preferredID);
  if (exact) {
    if (isConcreteModelID(exact.id)) return exact;
    return findConcreteSibling(exact, models) ?? exact;
  }

  const prefixMatch = matchConcreteSiblings(preferredID, models)[0];
  if (prefixMatch) return prefixMatch;

  const family = inferFamily(preferredID, models);
  if (!family) return undefined;

  return sortModels(
    models.filter((model) => model.family === family && isConcreteModelID(model.id)),
  )[0];
}

async function listProviderModels(providerID: string): Promise<CatalogModel[]> {
  const auth = await Auth.get(providerID);
  const authType = auth?.type === "proxy" ? "proxy" : "api";
  return Provider.listModels(providerID, authType);
}

export async function resolveRuntimeModel(
  model: RuntimeModel,
  defaultModel?: RuntimeModel,
): Promise<RuntimeModel> {
  try {
    const resolved = resolveCatalogModel(model.id, await listProviderModels(model.provider));
    if (resolved) {
      return { provider: model.provider, id: resolved.id };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[server] failed to resolve agent model ${model.provider}/${model.id}: ${msg}`);
  }

  if (defaultModel && defaultModel.provider === model.provider) {
    console.warn(
      `[server] falling back to default model for ${model.provider}/${model.id}: ${defaultModel.id}`,
    );
    return defaultModel;
  }

  return model;
}

export async function resolveDefaultProviderModel(): Promise<CatalogModel | undefined> {
  try {
    const credentials = await Auth.all();
    const entries = Object.entries(credentials);
    if (entries.length === 0) return undefined;

    const firstEntry = entries[0];
    if (!firstEntry) return undefined;

    const [providerID, auth] = firstEntry;
    const authType = auth.type === "proxy" ? "proxy" : "api";
    const models = await Provider.listModels(providerID, authType);
    const preferred = models[0];
    if (!preferred) return undefined;
    return resolveCatalogModel(preferred.id, models) ?? preferred;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[server] failed to resolve model: ${msg}`);
    return undefined;
  }
}
