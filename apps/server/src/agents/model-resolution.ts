import type { ChatAgentConfig } from "@openomni/agent";
import { Provider, type ModelCatalogService } from "@openomni/llm";
import type { SecretHandle, SecretRegistry } from "@openomni/llm/credential-runtime";
import { Execution } from "@openomni/protocol";

const DATE_SUFFIX_RE = /-\d{8}$/;

const statusOrder: Record<string, number> = {
  active: 0,
  beta: 1,
  alpha: 2,
  deprecated: 3,
};

type RuntimeModel = ChatAgentConfig["model"];
type CatalogModel = Provider.Model;

export interface RuntimeModelResolutionOptions {
  readonly model: RuntimeModel;
  readonly modelCatalog: ModelCatalogService;
  readonly secretRegistry: SecretRegistry;
  readonly credentialHandle: SecretHandle;
  readonly modelEnvironment: Execution.LLMEnvironmentV1;
}

export interface ResolvedRuntimeModel {
  readonly model: RuntimeModel;
  readonly environment: Execution.LLMEnvironmentV1;
  readonly credentialHandle: SecretHandle;
}

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

// Catalog lookup: alias → concrete sibling → prefix match. No family-level
// guess: if the requested ID is not in the catalog and has no concrete
// sibling, surface the miss to the caller so a stale catalog does not silently
// downgrade a newly-released model.
function resolveCatalogModel(
  preferredID: string,
  models: CatalogModel[],
): CatalogModel | undefined {
  const exact = models.find((model) => model.id === preferredID);
  if (exact) {
    if (isConcreteModelID(exact.id)) return exact;
    return findConcreteSibling(exact, models) ?? exact;
  }

  return matchConcreteSiblings(preferredID, models)[0];
}

function sameCredentialReference(
  left: Execution.CredentialSourceRefV1,
  right: Execution.CredentialSourceRefV1,
): boolean {
  return (
    left.version === right.version &&
    left.providerId === right.providerId &&
    left.authType === right.authType &&
    left.credentialId === right.credentialId &&
    left.rotationId === right.rotationId &&
    left.account === right.account &&
    left.sourceKind === right.sourceKind &&
    left.sourcePathDigest === right.sourcePathDigest &&
    left.endpointRef === right.endpointRef &&
    left.credentialDigest === right.credentialDigest
  );
}

function assertCredentialBinding(options: RuntimeModelResolutionOptions): void {
  const credential = options.secretRegistry.describe(options.credentialHandle);
  const environmentCredential = options.modelEnvironment.credential;
  if (
    credential.providerId !== options.model.provider ||
    !sameCredentialReference(credential, environmentCredential)
  ) {
    throw new Error(`Credential binding does not match model provider ${options.model.provider}`);
  }
}

export async function resolveRuntimeModel(
  options: RuntimeModelResolutionOptions,
): Promise<ResolvedRuntimeModel> {
  const environment = Execution.LLMEnvironmentV1.parse(options.modelEnvironment);
  assertCredentialBinding({ ...options, modelEnvironment: environment });

  const loadedCatalog = await options.modelCatalog.load();
  if (loadedCatalog.environment.environmentDigest !== environment.environmentDigest) {
    throw new Error("Model catalog environment does not match the injected LLM environment");
  }

  const models = await Provider.listModels(options.modelCatalog, options.model.provider);
  const resolved = resolveCatalogModel(options.model.id, models);
  if (!resolved) {
    throw new Error(
      `Model not found in provider catalog: ${options.model.provider}/${options.model.id}`,
    );
  }

  return Object.freeze({
    model: Object.freeze({ provider: options.model.provider, id: resolved.id }),
    environment,
    credentialHandle: options.credentialHandle,
  });
}
