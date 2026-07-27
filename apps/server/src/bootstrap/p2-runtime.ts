import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Execution } from "@openomni/protocol";
import type { KernelLedgerIncidentSinkV1, KernelQueryPortV1 } from "@openomni/openomni";
import { ModelsDev } from "@openomni/llm";
import {
  BoundarySanitizer,
  OwnerCredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import { Ledger } from "@openomni/session";

type ModelCatalogService = ReturnType<typeof ModelsDev.createService>;

export interface P2RedactedBootstrapSnapshotV1 {
  readonly version: "p2-redacted-bootstrap-snapshot-v1";
  readonly credentialRefs: readonly Execution.CredentialSourceRefV1[];
}

export interface P2RuntimeDependencies<TServices extends object = object> {
  readonly queries: KernelQueryPortV1;
  readonly services: TServices;
  readonly sanitizer: BoundarySanitizer;
  /** Already loaded by the LLM-owned credential boundary. */
  readonly secrets: SecretRegistry;
  readonly bootstrapSnapshot: P2RedactedBootstrapSnapshotV1;
  readonly modelEnvironment: Execution.LLMEnvironmentV1;
}

export type P2DormantRuntime<TServices extends object = object> = Readonly<
  P2RuntimeDependencies<TServices>
>;

/** Pure composition of package-owned ports, semantic services, and prevalidated secret-free state. */
export function composeP2Runtime<TServices extends object>(
  dependencies: P2RuntimeDependencies<TServices>,
): P2DormantRuntime<TServices> {
  if (!SecretRegistry.isSanitizerPair(dependencies.secrets, dependencies.sanitizer)) {
    throw new TypeError("Invalid SecretRegistry and BoundarySanitizer pair");
  }
  if (
    dependencies.services === null ||
    typeof dependencies.services !== "object" ||
    Object.keys(dependencies.services).length === 0
  ) {
    throw new TypeError("P2 semantic service bundle is required");
  }
  if (dependencies.bootstrapSnapshot.version !== "p2-redacted-bootstrap-snapshot-v1") {
    throw new TypeError("Unsupported P2 redacted bootstrap snapshot version");
  }
  const modelEnvironment = deepFreeze(
    Execution.LLMEnvironmentV1.parse(dependencies.modelEnvironment),
  );
  const credentialRefs = Object.freeze(
    dependencies.bootstrapSnapshot.credentialRefs.map((ref) =>
      deepFreeze(Execution.CredentialSourceRefV1.parse(ref)),
    ),
  );
  const bootstrapSnapshot = Object.freeze({
    version: dependencies.bootstrapSnapshot.version,
    credentialRefs,
  });

  return Object.freeze({
    queries: dependencies.queries,
    services: dependencies.services,
    sanitizer: dependencies.sanitizer,
    secrets: dependencies.secrets,
    bootstrapSnapshot,
    modelEnvironment,
  });
}

export interface P2ProductionKernelComposition<TServices extends object> {
  readonly queries: KernelQueryPortV1;
  /** Every server producer receives only these semantic ports. */
  readonly services: TServices;
}

export type P2ProductionRuntime<TServices extends object> = Readonly<
  P2DormantRuntime<TServices> & {
    readonly modelCatalog: ModelCatalogService;
    close(): Promise<void>;
  }
>;

export interface P2KernelCompositionContext {
  readonly sanitizer: BoundarySanitizer;
  readonly secrets: SecretRegistry;
  readonly loadedCredentials: Awaited<ReturnType<typeof OwnerCredentialSource.load>>;
  readonly modelEnvironment: Execution.LLMEnvironmentV1;
  readonly modelCatalog: ModelCatalogService;
  /** Sanitizer-backed, structural-only ledger diagnostics; raw errors are never accepted. */
  readonly incidentSink: KernelLedgerIncidentSinkV1;
}

export type P2KernelLedgerPort = Readonly<
  Pick<Ledger.LedgerRuntime, "append" | "query" | "readBlob">
>;

export interface OpenP2ProductionRuntimeOptions<TServices extends object> {
  readonly dbPath: string;
  readonly credentialPath?: string;
  readonly createIncidentSink: (sanitizer: BoundarySanitizer) => KernelLedgerIncidentSinkV1;

  readonly modelCatalog:
    | ModelCatalogService
    | ((
        credentials: Awaited<ReturnType<typeof OwnerCredentialSource.load>>,
      ) => ModelCatalogService);
  /**
   * Server-owned adapter factory. It receives only close-fenced structural operations and must
   * return semantic producer ports plus the closed authenticated query face.
   */
  createKernel(
    ledger: P2KernelLedgerPort,
    context: P2KernelCompositionContext,
  ): P2ProductionKernelComposition<TServices> | Promise<P2ProductionKernelComposition<TServices>>;
}

/**
 * Validates Owner credentials and the model catalog before opening the sole writable P2-clean
 * runtime. The returned runtime is dormant; callers explicitly start producers afterward.
 */
export async function openP2ProductionRuntime<TServices extends object>(
  options: OpenP2ProductionRuntimeOptions<TServices>,
): Promise<P2ProductionRuntime<TServices>> {
  const sanitizer = BoundarySanitizer.create();
  const secrets = SecretRegistry.create(sanitizer);
  let ownedLedger: Ledger.LedgerRuntime | undefined;
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  try {
    const loadedCredentials = await OwnerCredentialSource.load({
      ...(options.credentialPath === undefined ? {} : { path: options.credentialPath }),
      registry: secrets,
    });
    if (loadedCredentials.length === 0) {
      throw new TypeError("P2 production runtime requires an Owner credential");
    }
    const modelCatalog =
      typeof options.modelCatalog === "function"
        ? options.modelCatalog(loadedCredentials)
        : options.modelCatalog;
    const catalog = await modelCatalog.load();
    const incidentSink = options.createIncidentSink(sanitizer);
    if (typeof incidentSink?.report !== "function") {
      throw new TypeError("P2 production runtime requires a ledger incident sink");
    }

    mkdirSync(dirname(options.dbPath), { recursive: true });
    ownedLedger = Ledger.openLedgerRuntime({ dbPath: options.dbPath });
    const runtimeLedger = ownedLedger;
    const track = <T>(start: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new Error("P2 production runtime is closing"));
      let operation: Promise<T>;
      try {
        operation = start();
      } catch (error) {
        return Promise.reject(error);
      }
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    };
    const ledger: P2KernelLedgerPort = Object.freeze({
      append: (batch, appendOptions) => track(() => runtimeLedger.append(batch, appendOptions)),
      query: <T>(
        callback: (query: Parameters<Parameters<Ledger.LedgerRuntime["query"]>[0]>[0]) => T,
      ) => track(() => runtimeLedger.query(callback)),
      readBlob: (hash) => track(() => runtimeLedger.readBlob(hash)),
    });
    const kernel = await options.createKernel(
      ledger,
      Object.freeze({
        sanitizer,
        secrets,
        loadedCredentials,
        modelEnvironment: catalog.environment,
        modelCatalog,
        incidentSink,
      }),
    );
    assertProductionKernelComposition(kernel);
    const dormant = composeP2Runtime({
      queries: kernel.queries,
      sanitizer,
      services: kernel.services,
      secrets,
      bootstrapSnapshot: {
        version: "p2-redacted-bootstrap-snapshot-v1",
        credentialRefs: loadedCredentials.map(({ ref }) => ref),
      },
      modelEnvironment: catalog.environment,
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      queries: dormant.queries,
      services: dormant.services,
      sanitizer: dormant.sanitizer,
      secrets: dormant.secrets,
      bootstrapSnapshot: dormant.bootstrapSnapshot,
      modelEnvironment: dormant.modelEnvironment,
      modelCatalog,
      close() {
        closePromise ??= (async () => {
          closing = true;
          await Promise.allSettled([...pending]);
          try {
            await runtimeLedger.close();
          } finally {
            secrets.dispose();
          }
        })();
        return closePromise;
      },
    });
  } catch (error) {
    closing = true;
    await Promise.allSettled([...pending]);
    try {
      await ownedLedger?.close();
    } finally {
      secrets.dispose();
    }
    throw error;
  }
}

export function createP2ModelCatalog(
  options: Parameters<typeof ModelsDev.createService>[0],
): ModelCatalogService {
  return ModelsDev.createService(options);
}

function assertProductionKernelComposition<TServices extends object>(
  value: P2ProductionKernelComposition<TServices>,
): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.queries?.query !== "function" ||
    value.services === null ||
    typeof value.services !== "object"
  ) {
    throw new TypeError("Incomplete P2 production kernel composition");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
