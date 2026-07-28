import { Execution } from "@openomni/protocol";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export const CATALOG_CACHE_SCHEMA = "openomni.model-catalog-cache";
export const CATALOG_CACHE_SCHEMA_VERSION = 1;
export const CATALOG_CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;
export const CATALOG_FETCH_TIMEOUT_MS = 10_000;
export const CATALOG_CACHE_FILE_MODE = 0o600;

const BUNDLED_PROVIDER_PACKAGES = new Set(["@ai-sdk/anthropic", "@ai-sdk/openai"]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ENDPOINT_KEYS = new Set(["api", "endpoint", "baseurl", "url"]);
const PACKAGE_KEYS = new Set(["npm", "package", "packagename", "provider"]);
const RECOVERABLE_CACHE_READ_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EPERM",
  "ESTALE",
]);

export type CatalogSource = "remote" | "bundled";
export type SanitizedModel = Readonly<Record<string, unknown>>;
export type SanitizedProvider = Readonly<{
  id: string;
  name: string;
  env: readonly string[];
  npm: "@ai-sdk/anthropic" | "@ai-sdk/openai";
  models: Readonly<Record<string, SanitizedModel>>;
}>;
export type SanitizedCatalog = Readonly<Record<string, SanitizedProvider>>;

export type CatalogEnvironmentReference = Execution.LLMEnvironmentV1;

export type CatalogEnvironmentBinding = Readonly<
  Pick<
    Execution.LLMEnvironmentV1,
    "modelDigest" | "endpoint" | "credential" | "sdkPackage" | "adapterVersion"
  >
>;

export interface CatalogArtifact {
  readonly catalog: SanitizedCatalog;
  readonly environment: CatalogEnvironmentReference;
}

export interface BundledCatalog {
  readonly catalog: unknown;
  readonly version: string;
  readonly digest?: string;
}

export interface RemoteCatalog {
  readonly catalog: unknown;
  readonly version: string;
}

export interface CatalogCacheEnvelopeV1 {
  readonly schema: typeof CATALOG_CACHE_SCHEMA;
  readonly schemaVersion: typeof CATALOG_CACHE_SCHEMA_VERSION;
  readonly fetchedAt: number;
  readonly catalogSource: CatalogSource;
  readonly catalogVersion: string;
  readonly digest: string;
  readonly catalog: SanitizedCatalog;
}

export interface CacheFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface CatalogCacheFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: number, mode?: number): Promise<CacheFileHandle>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface CatalogCacheDependencies {
  readonly now: () => number;
  readonly digest: (canonicalCatalog: string) => Promise<string> | string;
  readonly fetchRemote: (boundary: { readonly timeoutMs: 10_000 }) => Promise<RemoteCatalog>;
  readonly fs: CatalogCacheFileSystem;
  readonly tempName: () => string;
}

export interface LoadCatalogOptions {
  readonly cachePath: string;
  readonly environment: CatalogEnvironmentBinding;
  readonly bundled?: BundledCatalog;
  readonly fetchDisabled?: boolean;
  readonly offline?: boolean;
}

export type CatalogFallbackStage =
  | "cache-read"
  | "cache-parse"
  | "cache-validation"
  | "remote-fetch"
  | "remote-validation"
  | "bundled-validation";

export type CatalogFallbackCause = Readonly<{
  name: "CatalogCacheFailure" | "CatalogExternalFailure" | "CatalogValidationFailure";
  message: string;
}>;

export type CatalogFallbackDiagnostic = Readonly<{
  stage: CatalogFallbackStage;
  cause: CatalogFallbackCause;
}>;

export interface LoadedCatalog extends CatalogArtifact {
  /** A validated remote result remains usable when persistence fails. */
  readonly cacheWriteError?: CatalogCacheWriteError;
  readonly fallbackDiagnostics: readonly CatalogFallbackDiagnostic[];
}

export class CatalogUnavailableError extends Error {
  readonly name = "CatalogUnavailableError";
  readonly cause?: CatalogFallbackCause;
  readonly fallbackDiagnostics: readonly CatalogFallbackDiagnostic[];

  constructor(
    message = "No validated model catalog is available",
    cause?: CatalogFallbackCause,
    fallbackDiagnostics: readonly CatalogFallbackDiagnostic[] = [],
  ) {
    super(message);
    this.cause = cause;
    this.fallbackDiagnostics = Object.freeze([...fallbackDiagnostics]);
  }
}

export class CatalogExternalFetchError extends Error {
  readonly name = "CatalogExternalFetchError";
}

export type CatalogCacheCleanupDiagnostic = Readonly<{
  operation: "close" | "unlink";
  message: string;
}>;

export class CatalogCacheWriteError extends Error {
  readonly name = "CatalogCacheWriteError";
  readonly cause?: unknown;
  readonly cleanupDiagnostics: readonly CatalogCacheCleanupDiagnostic[];

  constructor(
    readonly cachePath: string,
    cause?: unknown,
  ) {
    super(`Validated model catalog could not be persisted at ${cachePath}`);
    this.cause = cause instanceof CatalogCachePersistenceError ? cause.cause : cause;
    this.cleanupDiagnostics =
      cause instanceof CatalogCachePersistenceError ? cause.cleanupDiagnostics : Object.freeze([]);
  }
}

class CatalogCachePersistenceError extends Error {
  readonly name = "CatalogCachePersistenceError";

  constructor(
    readonly cause: unknown,
    readonly cleanupDiagnostics: readonly CatalogCacheCleanupDiagnostic[],
  ) {
    super("Model catalog cache persistence failed");
  }
}

class CatalogValidationError extends TypeError {
  readonly name = "CatalogValidationError";
}

export async function loadModelCatalog(
  options: LoadCatalogOptions,
  dependencies: CatalogCacheDependencies,
): Promise<LoadedCatalog> {
  const cache = await readValidatedCache(options.cachePath, dependencies);
  const fallbackDiagnostics: CatalogFallbackDiagnostic[] = [...cache.diagnostics];
  const cached = cache.envelope;
  const cacheAge = cached ? dependencies.now() - cached.fetchedAt : undefined;
  if (
    cached?.catalogSource === "remote" &&
    cacheAge !== undefined &&
    cacheAge >= 0 &&
    cacheAge <= CATALOG_CACHE_FRESHNESS_MS
  ) {
    return makeLoaded(
      cached.catalog,
      cached.catalogSource,
      cached.catalogVersion,
      cached.digest,
      options.environment,
      dependencies.digest,
      undefined,
      fallbackDiagnostics,
    );
  }

  if (!options.fetchDisabled && !options.offline) {
    let remote: RemoteCatalog | undefined;
    try {
      remote = await dependencies.fetchRemote({ timeoutMs: CATALOG_FETCH_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof CatalogExternalFetchError)) throw error;
      fallbackDiagnostics.push(fallbackDiagnostic("remote-fetch", "CatalogExternalFailure"));
    }
    if (remote) {
      let validated: Awaited<ReturnType<typeof validateCatalog>> | undefined;
      try {
        validated = await validateCatalog(remote.catalog, remote.version, dependencies.digest);
      } catch (error) {
        if (!(error instanceof CatalogValidationError)) throw error;
        fallbackDiagnostics.push(
          fallbackDiagnostic("remote-validation", "CatalogValidationFailure"),
        );
      }
      if (validated) {
        return persistValidatedCatalog(
          options.cachePath,
          "remote",
          remote.version,
          validated,
          options.environment,
          fallbackDiagnostics,
          dependencies,
        );
      }
    }
  }

  if (options.bundled) {
    try {
      const validated = await validateCatalog(
        options.bundled.catalog,
        options.bundled.version,
        dependencies.digest,
        options.bundled.digest,
      );
      return makeLoaded(
        validated.catalog,
        "bundled",
        options.bundled.version,
        validated.digest,
        options.environment,
        dependencies.digest,
        undefined,
        fallbackDiagnostics,
      );
    } catch (error) {
      if (!(error instanceof CatalogValidationError)) throw error;
      const diagnostic = fallbackDiagnostic("bundled-validation", "CatalogValidationFailure");
      const diagnostics = Object.freeze([...fallbackDiagnostics, diagnostic]);
      throw new CatalogUnavailableError(
        "Bundled model catalog failed validation",
        diagnostic.cause,
        diagnostics,
      );
    }
  }

  const cause = fallbackDiagnostics.at(-1)?.cause;
  throw new CatalogUnavailableError(undefined, cause, Object.freeze([...fallbackDiagnostics]));
}

export function sanitizeCatalog(input: unknown): SanitizedCatalog {
  const catalog = nullRecord<SanitizedProvider>();
  if (!isPlainRecord(input)) return Object.freeze(catalog);

  for (const providerID of Object.keys(input).sort()) {
    if (PROTOTYPE_KEYS.has(providerID)) continue;
    const rawProvider = input[providerID];
    if (!isPlainRecord(rawProvider)) continue;
    const npm = rawProvider.npm;
    if (typeof npm !== "string" || !BUNDLED_PROVIDER_PACKAGES.has(npm)) continue;
    if (typeof rawProvider.name !== "string" || !Array.isArray(rawProvider.env)) continue;

    const models = nullRecord<SanitizedModel>();
    if (isPlainRecord(rawProvider.models)) {
      for (const modelID of Object.keys(rawProvider.models).sort()) {
        if (PROTOTYPE_KEYS.has(modelID)) continue;
        const rawModel = rawProvider.models[modelID];
        if (!isPlainRecord(rawModel)) continue;
        if (typeof rawModel.id !== "string" || typeof rawModel.name !== "string") continue;
        const model = sanitizeRecord(rawModel, true);
        models[modelID] = Object.freeze(model);
      }
    }
    if (Object.keys(models).length === 0) continue;

    const provider: SanitizedProvider = Object.freeze({
      id: typeof rawProvider.id === "string" ? rawProvider.id : providerID,
      name: rawProvider.name,
      env: Object.freeze(
        rawProvider.env.filter((value): value is string => typeof value === "string"),
      ),
      npm: npm as SanitizedProvider["npm"],
      models: Object.freeze(models),
    });
    catalog[providerID] = provider;
  }
  return Object.freeze(catalog);
}

function hasValidatedModel(catalog: SanitizedCatalog): boolean {
  return Object.values(catalog).some((provider) => Object.keys(provider.models).length > 0);
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256CatalogDigest(canonicalCatalog: string): string {
  return createHash("sha256").update(canonicalCatalog).digest("hex");
}

export function nodeCatalogCacheFileSystem(): CatalogCacheFileSystem {
  return { readFile, mkdir, open, chmod, rename, unlink };
}

async function readValidatedCache(
  cachePath: string,
  dependencies: CatalogCacheDependencies,
): Promise<{
  envelope?: CatalogCacheEnvelopeV1;
  diagnostics: readonly CatalogFallbackDiagnostic[];
}> {
  let contents: string;
  try {
    contents = await dependencies.fs.readFile(cachePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return { diagnostics: [] };
    if (!isRecoverableCacheReadError(error)) throw error;
    return { diagnostics: [fallbackDiagnostic("cache-read", "CatalogCacheFailure")] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { diagnostics: [fallbackDiagnostic("cache-parse", "CatalogValidationFailure")] };
  }
  if (!isStrictEnvelope(parsed)) {
    return { diagnostics: [fallbackDiagnostic("cache-validation", "CatalogValidationFailure")] };
  }
  try {
    const validated = await validateCatalog(
      parsed.catalog,
      parsed.catalogVersion,
      dependencies.digest,
      parsed.digest,
    );
    return {
      envelope: Object.freeze({ ...parsed, catalog: validated.catalog }),
      diagnostics: [],
    };
  } catch (error) {
    if (!(error instanceof CatalogValidationError)) throw error;
    return { diagnostics: [fallbackDiagnostic("cache-validation", "CatalogValidationFailure")] };
  }
}

async function validateCatalog(
  input: unknown,
  version: string,
  digest: CatalogCacheDependencies["digest"],
  expectedDigest?: string,
): Promise<{ catalog: SanitizedCatalog; digest: string }> {
  if (typeof version !== "string" || version.length === 0)
    throw new CatalogValidationError("Missing catalog version");
  const catalog = sanitizeCatalog(input);
  if (!hasValidatedModel(catalog))
    throw new CatalogValidationError("Catalog has no supported models");
  const actualDigest = await digest(canonicalize(catalog));
  if (typeof actualDigest !== "string" || !/^[0-9a-f]{64}$/.test(actualDigest))
    throw new TypeError("Invalid digest");
  if (expectedDigest !== undefined && actualDigest !== expectedDigest) {
    throw new CatalogValidationError("Catalog digest does not match");
  }
  return { catalog, digest: actualDigest };
}

function isStrictEnvelope(value: unknown): value is CatalogCacheEnvelopeV1 {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    "catalog",
    "catalogSource",
    "catalogVersion",
    "digest",
    "fetchedAt",
    "schema",
    "schemaVersion",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    return false;
  return (
    value.schema === CATALOG_CACHE_SCHEMA &&
    value.schemaVersion === CATALOG_CACHE_SCHEMA_VERSION &&
    typeof value.fetchedAt === "number" &&
    Number.isFinite(value.fetchedAt) &&
    value.fetchedAt >= 0 &&
    (value.catalogSource === "remote" || value.catalogSource === "bundled") &&
    typeof value.catalogVersion === "string" &&
    value.catalogVersion.length > 0 &&
    typeof value.digest === "string" &&
    /^[0-9a-f]{64}$/.test(value.digest) &&
    isPlainRecord(value.catalog)
  );
}

async function writeEnvelopeAtomic(
  cachePath: string,
  envelope: CatalogCacheEnvelopeV1,
  dependencies: CatalogCacheDependencies,
): Promise<void> {
  const directory = dirname(cachePath);
  const tempToken = dependencies.tempName().replace(/[^a-zA-Z0-9.-]/g, "-");
  const tempPath = join(directory, `.${basename(cachePath)}.${tempToken}.tmp`);
  let handle: CacheFileHandle | undefined;
  let tempCreated = false;
  let renamed = false;
  let primaryError: unknown;
  const cleanupDiagnostics: CatalogCacheCleanupDiagnostic[] = [];
  try {
    await dependencies.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await dependencies.fs.open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      CATALOG_CACHE_FILE_MODE,
    );
    tempCreated = true;
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
    await handle.sync();
    const closingHandle = handle;
    handle = undefined;
    try {
      await closingHandle.close();
    } catch (error) {
      cleanupDiagnostics.push(cleanupDiagnostic("close"));
      throw error;
    }
    await dependencies.fs.chmod(tempPath, CATALOG_CACHE_FILE_MODE);
    await dependencies.fs.rename(tempPath, cachePath);
    renamed = true;
    await dependencies.fs.chmod(cachePath, CATALOG_CACHE_FILE_MODE);
    const directoryHandle = await dependencies.fs.open(directory, constants.O_RDONLY);
    let directoryError: unknown;
    try {
      await directoryHandle.sync();
    } catch (error) {
      directoryError = error;
    } finally {
      try {
        await directoryHandle.close();
      } catch (error) {
        cleanupDiagnostics.push(cleanupDiagnostic("close"));
        directoryError ??= error;
      }
    }
    if (directoryError !== undefined) throw directoryError;
  } catch (error) {
    primaryError = error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        cleanupDiagnostics.push(cleanupDiagnostic("close"));
        primaryError ??= error;
      }
    }
    if (tempCreated && !renamed) {
      try {
        await dependencies.fs.unlink(tempPath);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          cleanupDiagnostics.push(cleanupDiagnostic("unlink"));
          primaryError ??= error;
        }
      }
    }
  }
  if (primaryError !== undefined) {
    throw new CatalogCachePersistenceError(primaryError, Object.freeze([...cleanupDiagnostics]));
  }
}

async function persistValidatedCatalog(
  cachePath: string,
  source: CatalogSource,
  version: string,
  validated: Awaited<ReturnType<typeof validateCatalog>>,
  binding: CatalogEnvironmentBinding,
  fallbackDiagnostics: readonly CatalogFallbackDiagnostic[],
  dependencies: CatalogCacheDependencies,
): Promise<LoadedCatalog> {
  const envelope: CatalogCacheEnvelopeV1 = {
    schema: CATALOG_CACHE_SCHEMA,
    schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
    fetchedAt: dependencies.now(),
    catalogSource: source,
    catalogVersion: version,
    digest: validated.digest,
    catalog: validated.catalog,
  };
  let cacheWriteError: CatalogCacheWriteError | undefined;
  try {
    await writeEnvelopeAtomic(cachePath, envelope, dependencies);
  } catch (error) {
    if (!(error instanceof CatalogCachePersistenceError)) throw error;
    cacheWriteError = new CatalogCacheWriteError(cachePath, error);
  }
  return makeLoaded(
    validated.catalog,
    source,
    version,
    validated.digest,
    binding,
    dependencies.digest,
    cacheWriteError,
    fallbackDiagnostics,
  );
}

async function makeLoaded(
  catalog: SanitizedCatalog,
  source: CatalogSource,
  version: string,
  digest: string,
  binding: CatalogEnvironmentBinding,
  computeDigest: CatalogCacheDependencies["digest"],
  cacheWriteError?: CatalogCacheWriteError,
  fallbackDiagnostics: readonly CatalogFallbackDiagnostic[] = [],
): Promise<LoadedCatalog> {
  const projectedBinding: CatalogEnvironmentBinding = {
    modelDigest: binding.modelDigest,
    endpoint: binding.endpoint,
    credential: binding.credential,
    sdkPackage: binding.sdkPackage,
    adapterVersion: binding.adapterVersion,
  };
  const base = {
    ...projectedBinding,
    version: "llm-environment-v1" as const,
    catalogSchemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
    catalogSource: source,
    catalogSourceVersion: version,
    catalogDigest: digest,
  };
  const environment = Execution.LLMEnvironmentV1.parse({
    ...base,
    environmentDigest: await computeDigest(canonicalize(base)),
  });
  return Object.freeze({
    catalog,
    environment: deepFreeze(environment),
    fallbackDiagnostics: Object.freeze([...fallbackDiagnostics]),
    ...(cacheWriteError ? { cacheWriteError } : {}),
  });
}

function sanitizeRecord(
  input: Record<string, unknown>,
  stripPackage: boolean,
): Record<string, unknown> {
  const output = nullRecord<unknown>();
  for (const key of Object.keys(input).sort()) {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    if (PROTOTYPE_KEYS.has(key) || ENDPOINT_KEYS.has(normalized)) continue;
    if (stripPackage && (PACKAGE_KEYS.has(key) || PACKAGE_KEYS.has(normalized))) continue;
    const value = sanitizeValue(input[key]);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value))
    return Object.freeze(value.map(sanitizeValue).filter((item) => item !== undefined));
  if (isPlainRecord(value)) return Object.freeze(sanitizeRecord(value, true));
  return undefined;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainRecord(value)) {
    const output = nullRecord<unknown>();
    for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
    return output;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function fallbackDiagnostic(
  stage: CatalogFallbackStage,
  name: CatalogFallbackDiagnostic["cause"]["name"],
): CatalogFallbackDiagnostic {
  const messages: Record<CatalogFallbackStage, string> = {
    "cache-read": "The model catalog cache could not be read",
    "cache-parse": "The model catalog cache was not valid JSON",
    "cache-validation": "The model catalog cache failed validation",
    "remote-fetch": "The remote model catalog could not be fetched",
    "remote-validation": "The remote model catalog failed validation",
    "bundled-validation": "The bundled model catalog failed validation",
  };
  return Object.freeze({
    stage,
    cause: Object.freeze({ name, message: messages[stage] }),
  });
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

function isRecoverableCacheReadError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Error & { code?: unknown }).code === "string" &&
    RECOVERABLE_CACHE_READ_CODES.has((error as Error & { code: string }).code)
  );
}

function cleanupDiagnostic(
  operation: CatalogCacheCleanupDiagnostic["operation"],
): CatalogCacheCleanupDiagnostic {
  return Object.freeze({
    operation,
    message:
      operation === "close"
        ? "A model catalog cache file handle could not be closed"
        : "A model catalog cache temporary file could not be removed",
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
