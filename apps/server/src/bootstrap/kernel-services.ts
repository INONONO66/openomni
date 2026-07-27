import { createHash } from "node:crypto";
import { Execution, type Ipc, Operational } from "@openomni/protocol";
import { ModelsDev, Provider, type ModelCatalogService } from "@openomni/llm";
import type {
  LoadedOwnerCredential,
  MaterializedCredential,
} from "@openomni/llm/credential-runtime";
import { Bus } from "@openomni/session";
import {
  createProductionKernelServices,
  createProductionKernelStructuralPorts,
  createWorkspaceIdentity,
  type KernelLedgerIncidentV1,
  type ProductionKernelContext,
  type WorkspaceIdentity,
} from "@openomni/openomni";
import type { ServerConfig } from "../config";
import {
  createP2WorkerTransferCredentialRef,
  encodeP2PrivateProvisioningFrame,
  p2ProvisioningAuthenticationTag,
  type ProvisionedCredentialMaterial,
} from "../execution/p2-worker-provisioning";
import { createIncidentSink } from "../server/incidents";
import type { ServerBootstrapComposition, ServerSemanticServices } from "./index";
import { createP2ModelCatalog, openP2ProductionRuntime } from "./p2-runtime";

type LoadedCredentials = readonly LoadedOwnerCredential[];
const SDK_PACKAGE_BY_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
});
const UNRESOLVED_MODEL_DIGEST = "0".repeat(64);

function sdkPackage(provider: string): string {
  const value = SDK_PACKAGE_BY_PROVIDER[provider];
  if (value === undefined)
    throw new TypeError(`Unsupported production model provider: ${provider}`);
  return value;
}
function modelEnvironmentEndpoint(
  providerId: string,
  credential: Execution.CredentialSourceRefV1,
): Execution.LLMEndpointRefV1 {
  if (credential.authType === "proxy") {
    const endpointRef = credential.endpointRef;
    if (endpointRef === undefined || !endpointRef.startsWith("proxy:")) {
      throw new TypeError("Proxy Owner credential is missing canonical endpoint provenance");
    }
    const baseURL = endpointRef.slice("proxy:".length);
    if (baseURL.length === 0) {
      throw new TypeError("Proxy Owner credential is missing canonical endpoint provenance");
    }
    return Execution.LLMEndpointRefV1.parse({
      version: "llm-endpoint-ref-v1",
      kind: "proxy",
      valueRef: endpointRef,
      endpointDigest: digest(baseURL),
    });
  }
  const endpointValue = `${providerId}:default`;
  return Execution.LLMEndpointRefV1.parse({
    version: "llm-endpoint-ref-v1",
    kind: "default",
    valueRef: endpointValue,
    endpointDigest: digest(endpointValue),
  });
}

export interface ValidatedProductionConfig {
  readonly model: NonNullable<ServerConfig["model"]>;
  readonly workspaceIdentity: WorkspaceIdentity;
}
export function validateProductionConfig(config: ServerConfig): ValidatedProductionConfig {
  if (config.model === undefined)
    throw new TypeError("P2 production composition requires an explicit Owner model");
  sdkPackage(config.model.provider);
  return Object.freeze({
    model: config.model,
    workspaceIdentity: createWorkspaceIdentity(config.workspace?.root ?? process.cwd()),
  });
}

export function createProductionModelCatalog(
  config: ValidatedProductionConfig,
  dbPath: string,
  credentials: LoadedCredentials,
): ModelCatalogService {
  const credential = credentials.find(({ ref }) => ref.providerId === config.model.provider);
  if (credential === undefined)
    throw new TypeError(`Owner credential is missing for model provider ${config.model.provider}`);
  const catalog = createP2ModelCatalog({
    cachePath: `${dbPath}.model-catalog.json`,
    environment: {
      modelDigest: UNRESOLVED_MODEL_DIGEST,
      endpoint: modelEnvironmentEndpoint(config.model.provider, credential.ref),
      credential: credential.ref,
      sdkPackage: sdkPackage(config.model.provider),
      adapterVersion: "1",
    },
  });
  const load: ModelCatalogService["load"] = async () => {
    const loaded = await catalog.load();
    const provider = loaded.catalog[config.model.provider];
    const configuredModel = provider?.models[config.model.id];
    if (provider === undefined || configuredModel === undefined) {
      throw new TypeError(
        `Configured Owner model is absent from the validated catalog: ${config.model.provider}/${config.model.id}`,
      );
    }
    const model = Provider.fromModelsDevModel(
      ModelsDev.Provider.parse(provider),
      ModelsDev.Model.parse(configuredModel),
    );
    const pinnedCatalog = deepFreeze({
      [config.model.provider]: {
        ...provider,
        env: [...provider.env],
        models: { [config.model.id]: configuredModel },
      },
    });
    const { environmentDigest: _environmentDigest, ...environmentBase } = loaded.environment;
    const canonicalEnvironmentBase = Object.freeze({
      ...environmentBase,
      modelDigest: Provider.modelDigest(model),
    });
    const environment = deepFreeze(
      Execution.LLMEnvironmentV1.parse({
        ...canonicalEnvironmentBase,
        environmentDigest: Provider.environmentDigest(canonicalEnvironmentBase),
      }),
    );
    return Object.freeze({
      ...loaded,
      catalog: pinnedCatalog,
      environment,
    });
  };
  return Object.freeze({
    load,
    async get() {
      return (await load()).catalog;
    },
  });
}

export function createProductionComposition(config: ServerConfig): ServerBootstrapComposition {
  const validated = validateProductionConfig(config);
  return Object.freeze({
    workspaceIdentity: validated.workspaceIdentity,
    openRuntime(dbPath: string) {
      return openP2ProductionRuntime<ServerSemanticServices>({
        dbPath,
        createIncidentSink: (sanitizer) => {
          const sink = createIncidentSink({
            sanitizer,
            publish: (incident) =>
              Bus.publish(Operational.Error, {
                traceId: incident.incidentId,
                time: incident.occurredAt,
                component: incident.component,
                msg: incident.summary,
                context: incident.data === undefined ? {} : { data: incident.data },
              }),
          });
          return Object.freeze({
            report(incident: KernelLedgerIncidentV1) {
              sink.report({
                component: "kernel-ledger",
                summary: `${incident.failureClass}:${incident.code}:${incident.outcome}`,
                data: incident,
              });
            },
          });
        },
        modelCatalog: (credentials) => createProductionModelCatalog(validated, dbPath, credentials),
        createKernel(ledger, context) {
          const clock = Object.freeze({ now: () => Date.now() });
          const { structural, queries } = createProductionKernelStructuralPorts(ledger, {
            identity: {
              runtimeId: "server-kernel",
              workerId: "server-kernel",
              generation: 0,
              principalId: "server",
            },
            clock,
            incidentSink: context.incidentSink,
            credentialRefs: context.loadedCredentials.map(({ ref }) => ref),
          });
          const semantic = createProductionKernelServices({
            ...structural,
            config: {
              model: { provider: validated.model.provider, id: validated.model.id },
              modelEnvironment: context.modelEnvironment,
              workspaceIdentity: validated.workspaceIdentity,
            },
            clock,
            incidents: {
              report(incident: Parameters<ProductionKernelContext["incidents"]["report"]>[0]) {
                const sink = createIncidentSink({
                  sanitizer: context.sanitizer,
                  publish: (redacted) =>
                    Bus.publish(Operational.Error, {
                      traceId: redacted.incidentId,
                      time: redacted.occurredAt,
                      component: redacted.component,
                      msg: redacted.summary,
                      context: redacted.data === undefined ? {} : { data: redacted.data },
                    }),
                });
                sink.report({
                  component: "production-kernel",
                  summary: incident.code,
                  data: incident,
                });
                sink.dispose();
              },
            },
            host: {
              async observe(observation) {
                Bus.publish(Operational.Info, {
                  traceId: crypto.randomUUID(),
                  time: clock.now(),
                  component: "production-kernel",
                  msg: observation.kind,
                  context: {
                    subjectId: observation.subjectId,
                    detail: context.sanitizer.sanitizeValue(
                      "production-observation",
                      observation.detail ?? {},
                    ),
                  },
                });
              },
            },
          });
          const modelCredential = requireCredential(
            context.loadedCredentials,
            validated.model.provider,
          );

          const createWorkerRuntimeDefinition: ServerSemanticServices["createWorkerRuntimeDefinition"] =
            (bootstrap) => async (binding, task) => {
              const attempt = await semantic.workerAttempts.queries.byExecution(task);
              if (attempt === undefined) throw new Error("worker runtime definition denied");
              const attemptRef: Ipc.CredentialProvisioningReceiptV1["attempt"] = {
                version: "attempt-ref-v1",
                workItemId: attempt.workItemId,
                attemptId: attempt.attemptId,
                attemptSeq: attempt.attemptSeq,
              };
              const credentialRef = await context.secrets.withMaterialized(
                modelCredential.handle,
                validated.model.provider,
                (credential) =>
                  createP2WorkerTransferCredentialRef({
                    ownerRef: modelCredential.ref,
                    peerIdentity: binding,
                    attempt: attemptRef,
                    credential,
                  }),
              );
              return semantic.runtimeDefinitions.create(bootstrap, binding, task, credentialRef);
            };

          const provisionCredentials: ServerSemanticServices["provisionCredentials"] = async (
            frame,
            signer,
          ) => {
            const authorization = await semantic.credentialProvisioning.authorize(frame);
            try {
              if (signer === undefined || authorization.request.expiresAt <= clock.now())
                throw new Error("credential provisioning denied");
              if (
                authorization.binding.credentialRef.providerId !== modelCredential.ref.providerId ||
                authorization.binding.credentialRef.authType !== modelCredential.ref.authType ||
                authorization.binding.credentialRef.credentialId !==
                  modelCredential.ref.credentialId ||
                authorization.binding.credentialRef.account !== modelCredential.ref.account ||
                authorization.binding.credentialRef.endpointRef !== modelCredential.ref.endpointRef
              ) {
                throw new Error("credential provisioning denied");
              }
              const material = await context.secrets.withMaterialized(
                modelCredential.handle,
                modelCredential.ref.providerId,
                (credential) => materializeForTransfer(credential, modelCredential.ref),
              );
              const credentials = [material];
              const peerIdentity = {
                runtimeId: authorization.binding.runtimeId,
                workerId: authorization.binding.workerId,
                generation: authorization.binding.generation,
                principalId: authorization.binding.principalId,
                processId: authorization.binding.processId,
              };
              let privateFrame: Uint8Array;
              try {
                const authenticationTag = p2ProvisioningAuthenticationTag(
                  signer,
                  authorization.request,
                  peerIdentity,
                  credentials,
                );
                try {
                  privateFrame = encodeP2PrivateProvisioningFrame({
                    peerIdentity,
                    authenticationTag,
                    credentials,
                  });
                } finally {
                  authenticationTag.fill(0);
                }
              } finally {
                scrubMaterial(material);
              }
              const receipt = Execution.CredentialProvisioningReceiptV1.parse({
                version: "credential-provisioning-receipt-v1",
                runtimeId: authorization.request.runtimeId,
                workerId: authorization.request.workerId,
                generation: authorization.request.generation,
                principalId: authorization.request.principalId,
                attempt: authorization.request.attempt,
                nonceRef: authorization.request.nonceRef,
                acceptedCredentialDigests: [authorization.binding.credentialRef.credentialDigest],
                acceptedAtDbMs: clock.now(),
              });
              return Object.freeze({
                privateFrame,
                receipt,
                acknowledge: (acknowledgement: Ipc.CredentialProvisioningAcknowledgementV1) =>
                  semantic.credentialProvisioning.confirm(authorization, receipt, acknowledgement),
              });
            } catch (error) {
              semantic.credentialProvisioning.release(authorization);
              throw error;
            }
          };

          const services: ServerSemanticServices = Object.freeze({
            model: { providerID: validated.model.provider, id: validated.model.id },
            modelCredential: modelCredential.handle,
            connectorCredentials: connectorCredentialClaims(context.loadedCredentials),
            modelCatalog: context.modelCatalog,
            secretRegistry: context.secrets,
            modelEnvironment: context.modelEnvironment,
            messagingLedger: semantic.messagingLedger,
            ingressKernel: semantic.ingressKernel,
            waitKernel: semantic.waitKernel,
            authorityQueries: semantic.authorityQueries,
            effects: semantic.effects,
            scheduleService: semantic.scheduleService,
            workerAttempts: semantic.workerAttempts,
            workerLedger: semantic.workerLedger,
            ownerTaskQueries: semantic.ownerTaskQueries,
            observabilityQueries: semantic.observabilityQueries,
            residentInboundWait: semantic.residentAskLifecycle,
            connectorQueries: semantic.connectorQueries,
            connectorTransitions: semantic.connectorTransitions,
            connectorArtifacts: semantic.connectorArtifacts,
            events: Object.freeze({ publish: Bus.publish }),
            workerKernelTransition: semantic.workerKernelTransition,
            workerKernelQuery: semantic.workerKernelQuery,
            workerObservation: async (event: Ipc.WorkerObservationV1) =>
              semantic.observations.observe({
                version: "production-observation-v1",
                kind: "worker",
                subjectId: event.workerId,
                detail: { event },
              }),
            provisionCredentials,
            createWorkerRuntimeDefinition,
            recoverInterruptedRuns: semantic.recoverInterruptedRuns,
            recovery: semantic.recovery,
            cron: semantic.cron,
          });
          return Object.freeze({
            queries,
            services,
          });
        },
      });
    },
  });
}

function requireCredential(
  credentials: LoadedCredentials,
  providerId: string,
): LoadedOwnerCredential {
  const credential = credentials.find(({ ref }) => ref.providerId === providerId);
  if (credential === undefined)
    throw new TypeError(`Owner credential is missing for ${providerId}`);
  return credential;
}
function connectorCredentialClaims(
  credentials: LoadedCredentials,
): ServerSemanticServices["connectorCredentials"] {
  const claims = Object.create(null) as Record<string, LoadedOwnerCredential["handle"]>;
  for (const credential of credentials) {
    const claim = credential.ref.credentialId;
    if (Object.getOwnPropertyDescriptor(claims, claim) !== undefined) {
      throw new TypeError(`Duplicate Owner connector credential claim: ${claim}`);
    }
    claims[claim] = credential.handle;
  }
  return Object.freeze(claims);
}
function materializeForTransfer(
  credential: MaterializedCredential,
  ref: Execution.CredentialSourceRefV1,
): ProvisionedCredentialMaterial {
  if (credential.authType === "api") {
    return {
      providerId: ref.providerId,
      credentialId: ref.credentialId,
      authType: "api",
      secret: credential.key.slice(),
    };
  }
  return {
    providerId: ref.providerId,
    credentialId: ref.credentialId,
    authType: "proxy",
    baseURL: credential.baseURL,
    ...(credential.apiKey === undefined ? {} : { secret: credential.apiKey.slice() }),
  };
}

function scrubMaterial(material: ProvisionedCredentialMaterial): void {
  if (material.authType === "api") material.secret.fill(0);
  else material.secret?.fill(0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
