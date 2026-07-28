import type { Adapter, BusEvent, Ingress } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import {
  AgentToolProvider,
  IngressEngine,
  ResidentRuntime,
  SystemToolProvider,
  createDefaultDispatchRuntime,
  createWorkspaceIdentity,
  type DefaultDispatchRuntimeOptions,
  type DispatchRuntime,
  type WorkspaceIdentity,
  type ProductionSemanticServices,
} from "@openomni/openomni";
import type {
  WorkerCredentialProvisioningPort,
  WorkerKernelQueryPort,
  WorkerKernelTransitionPort,
  WorkerObservationPort,
} from "@openomni/coordinator";
import type { SecretHandle } from "@openomni/llm/credential-runtime";
import { loadConfig } from "../config";
import { McpConfigLoader } from "../context/index";
import { createExecutionCoordinator } from "../execution/coordinator";
import {
  createMessageHandler,
  type ConversationHandlerDeps,
  type OwnerTaskProjectionQuery,
} from "../handler/conversation";
import { buildAgentDef } from "../ingress/bridge";
import { createRouter, type OwnerObservabilityProjectionQuery } from "../server/routes";
import { createIncidentSink } from "../server/incidents";
import { CustomToolProvider } from "../tool/custom";
import { McpToolProvider } from "../tool/mcp";
import type {
  ConnectorEndpointCredentialMap,
  ConnectorEndpointKernelQueries,
} from "../connector/process-driver";
import type { ConnectorArtifactWriter } from "../connector/log";
import { registerAgent } from "../agents";
import { createResidentProfile } from "../profile/resident";
import { createChannelAdapters } from "./channels";
import { createServerDispatchOwners } from "./dispatch-owners";
import { connectMcpServers } from "./mcp";
import type { P2ProductionRuntime } from "./p2-runtime";
import { runRecovery, type RecoveryServices } from "./recovery";
import {
  createResidentInboundWaitHandler,
  type ResidentInboundWaitLedgerService,
} from "./resident-inbound-wait";
import { installShutdownHandlers } from "./shutdown";
import { assembleBootstrap } from "./worker-bootstrap";

export interface ServerSemanticServices {
  readonly model: { readonly providerID: string; readonly id: string };
  readonly modelCredential: SecretHandle;
  readonly connectorCredentials: ConnectorEndpointCredentialMap;
  readonly modelCatalog: ConversationHandlerDeps["modelCatalog"];
  readonly secretRegistry: ConversationHandlerDeps["secretRegistry"];
  readonly modelEnvironment: ConversationHandlerDeps["modelEnvironment"];
  readonly messagingLedger: ProductionSemanticServices["messagingLedger"];
  readonly ingressKernel: ProductionSemanticServices["ingressKernel"];
  readonly waitKernel: ProductionSemanticServices["waitKernel"];
  readonly authorityQueries: ProductionSemanticServices["authorityQueries"];
  readonly effects: ProductionSemanticServices["effects"];
  readonly scheduleService: ProductionSemanticServices["scheduleService"];
  readonly workerAttempts: ProductionSemanticServices["workerAttempts"];
  readonly workerLedger: ProductionSemanticServices["workerLedger"];
  readonly ownerTaskQueries: OwnerTaskProjectionQuery;
  readonly observabilityQueries: OwnerObservabilityProjectionQuery;
  readonly residentInboundWait: ResidentInboundWaitLedgerService;
  readonly connectorQueries: ConnectorEndpointKernelQueries;
  readonly connectorTransitions: ProductionSemanticServices["connectorTransitions"];
  readonly connectorArtifacts: ConnectorArtifactWriter;
  readonly events: BusEvent.Sink;
  readonly workerKernelTransition: WorkerKernelTransitionPort;
  readonly workerKernelQuery: WorkerKernelQueryPort;
  readonly workerObservation: WorkerObservationPort;
  readonly provisionCredentials: WorkerCredentialProvisioningPort;
  readonly createWorkerRuntimeDefinition: (
    bootstrap: Awaited<ReturnType<typeof assembleBootstrap>>,
  ) => Parameters<typeof createExecutionCoordinator>[0]["runtimeDefinition"];
  readonly recoverInterruptedRuns: Parameters<
    typeof createExecutionCoordinator
  >[0]["runtime"]["services"]["recoverInterruptedRuns"];
  readonly recovery: RecoveryServices;
  readonly cron: ProductionSemanticServices["cron"];
}

const REQUIRED_SERVICE_KEYS = [
  "model",
  "modelCredential",
  "connectorCredentials",
  "modelCatalog",
  "secretRegistry",
  "modelEnvironment",
  "messagingLedger",
  "ingressKernel",
  "waitKernel",
  "authorityQueries",
  "effects",
  "scheduleService",
  "workerAttempts",
  "workerLedger",
  "ownerTaskQueries",
  "observabilityQueries",
  "residentInboundWait",
  "connectorQueries",
  "connectorTransitions",
  "connectorArtifacts",
  "events",
  "workerKernelTransition",
  "workerKernelQuery",
  "workerObservation",
  "provisionCredentials",
  "createWorkerRuntimeDefinition",
  "recoverInterruptedRuns",
  "recovery",
  "cron",
] as const satisfies readonly (keyof ServerSemanticServices)[];

function requireSemanticServices(
  services: ServerSemanticServices | undefined,
): ServerSemanticServices {
  if (services === undefined || services === null || typeof services !== "object") {
    throw new TypeError("P2 semantic service bundle is required");
  }
  for (const key of REQUIRED_SERVICE_KEYS) {
    if (services[key] === undefined || services[key] === null) {
      throw new TypeError(`P2 semantic service bundle is missing ${key}`);
    }
  }
  return services;
}

export interface ServerBootstrapComposition {
  readonly workspaceIdentity: WorkspaceIdentity;
  openRuntime(dbPath: string): Promise<P2ProductionRuntime<ServerSemanticServices>>;
}

function requireComposition(
  composition: ServerBootstrapComposition | undefined,
): ServerBootstrapComposition {
  if (composition === undefined) {
    throw new TypeError("P2 server bootstrap requires an explicit semantic runtime composition");
  }
  return composition;
}

function createRoutingHandler(
  systemProvider: SystemToolProvider,
  agentProvider: AgentToolProvider,
  mcpProvider: McpToolProvider,
  customProvider: CustomToolProvider,
  workspaceRoot: string,
  defaultModel: { provider: string; id: string },
  ownerTaskQueries: OwnerTaskProjectionQuery,
  modelCatalog: ConversationHandlerDeps["modelCatalog"],
  secretRegistry: ConversationHandlerDeps["secretRegistry"],
  credentialHandle: ConversationHandlerDeps["credentialHandle"],
  modelEnvironment: ConversationHandlerDeps["modelEnvironment"],
): Adapter.MessageHandler {
  return createMessageHandler({
    systemProvider,
    agentProvider,
    mcpProvider,
    customProvider,
    defaultModel,
    workspaceRoot,
    ownerTaskQueries,
    modelCatalog,
    secretRegistry,
    credentialHandle,
    modelEnvironment,
  });
}

export async function main(injected?: ServerBootstrapComposition): Promise<void> {
  const composition = requireComposition(injected);
  const config = loadConfig();

  const configuredModel = config.model;
  if (configuredModel === undefined) {
    throw new TypeError("P2 server bootstrap requires an explicit model");
  }
  if (config.workspace?.root !== undefined) {
    const configuredWorkspace = createWorkspaceIdentity(config.workspace.root);
    if (
      configuredWorkspace.workspaceId !== composition.workspaceIdentity.workspaceId ||
      configuredWorkspace.canonicalBytesDigest !==
        composition.workspaceIdentity.canonicalBytesDigest
    ) {
      throw new TypeError("Configured workspace does not match the provisioned workspace identity");
    }
  }

  const runtime = await composition.openRuntime(config.storage.dbPath);
  let services: ServerSemanticServices;
  try {
    services = requireSemanticServices(runtime.services);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const workspaceIdentity = composition.workspaceIdentity;
  const workspaceRoot = workspaceIdentity.canonicalRoot;
  const mode = runtime.sanitizer.sanitizeText(
    "bootstrap.openomni-mode",
    process.env.OPENOMNI_MODE ?? "",
  );
  if (mode === "local") {
    await runtime.close();
    throw new Error("OPENOMNI_MODE=local is disabled; OpenOmni requires coordinator mode");
  }
  const residentIdleTimeoutMs = Number(
    runtime.sanitizer.sanitizeText(
      "bootstrap.resident-idle-timeout-ms",
      process.env.OPENOMNI_RESIDENT_IDLE_TIMEOUT_MS ?? "30000",
    ),
  );
  const workerIdleTimeoutMs = Number(
    runtime.sanitizer.sanitizeText(
      "bootstrap.worker-idle-timeout-ms",
      process.env.OPENOMNI_WORKER_IDLE_TIMEOUT_MS ?? "30000",
    ),
  );
  if (
    !Number.isSafeInteger(residentIdleTimeoutMs) ||
    residentIdleTimeoutMs <= 0 ||
    !Number.isSafeInteger(workerIdleTimeoutMs) ||
    workerIdleTimeoutMs <= 0
  ) {
    await runtime.close();
    throw new TypeError("P2 server bootstrap idle timeouts must be positive safe integers");
  }
  if (
    services.model.providerID !== configuredModel.provider ||
    services.model.id !== configuredModel.id
  ) {
    await runtime.close();
    throw new TypeError("Configured model does not match the composed LLM environment");
  }

  const incidents = createIncidentSink({
    sanitizer: runtime.sanitizer,
    publish: (incident) =>
      services.events.publish(Operational.Error, {
        traceId: incident.incidentId,
        time: incident.occurredAt,
        component: incident.component,
        msg: incident.summary,
        context: incident.data === undefined ? {} : { data: incident.data },
      }),
  });
  const systemProvider = new SystemToolProvider(workspaceIdentity);
  const mcpProvider = new McpToolProvider({
    workspaceIdentity,
    effects: services.effects,
  });
  const customProvider = new CustomToolProvider({
    workspaceIdentity,
    effects: services.effects,
  });

  const projectMcpServers = McpConfigLoader.discover(workspaceRoot);
  const mergedMcpConfig = {
    ...config.mcp,
    servers: McpConfigLoader.merge(config.mcp.servers, projectMcpServers),
  };
  await connectMcpServers({ ...config, mcp: mergedMcpConfig }, mcpProvider);

  const residentRuntime = new ResidentRuntime({
    maxActive: 10,
    idleTimeoutMs: residentIdleTimeoutMs,
    environment: {
      reference: runtime.modelEnvironment,
      credential: services.modelCredential,
      secrets: runtime.secrets,
      sanitizer: runtime.sanitizer,
    },
    modelCatalog: runtime.modelCatalog,
  });
  IngressEngine.setMessagingLedgerService(services.messagingLedger);
  IngressEngine.setKernelPorts(services.ingressKernel);
  IngressEngine.setResidentRuntime(residentRuntime);

  const residentProfile = await createResidentProfile({
    model: { provider: services.model.providerID, id: services.model.id },
  });
  registerAgent(residentProfile.factory, residentProfile.metadata);

  const dispatchRuntimeRef: { current?: DispatchRuntime } = {};
  const requireDispatchRuntime = (): DispatchRuntime => {
    if (!dispatchRuntimeRef.current) throw new Error("dispatch runtime is not configured");
    return dispatchRuntimeRef.current;
  };
  const bootstrap = await assembleBootstrap(mcpProvider, customProvider);
  let agentProvider: AgentToolProvider;
  const coordinator = createExecutionCoordinator({
    workerScript: new URL("../execution/worker-entry.ts", import.meta.url).pathname,
    runtimeId: crypto.randomUUID(),
    principalId: "server",
    bootstrap,
    runtime,
    events: services.events,
    kernelTransition: services.workerKernelTransition,
    kernelQuery: services.workerKernelQuery,
    observation: services.workerObservation,
    provisionCredentials: services.provisionCredentials,
    runtimeDefinition: services.createWorkerRuntimeDefinition(bootstrap),
    getAgentToolProvider: () => {
      if (agentProvider === undefined) throw new Error("agent tool provider is not configured");
      return agentProvider;
    },
    toolProviders: [mcpProvider, customProvider],
    askResident: createResidentInboundWaitHandler({
      workspaceIdentity,
      lifecycle: services.residentInboundWait,
      settlements: services.workerAttempts,
      dispatchRuntime: {
        submit: (input, options) => requireDispatchRuntime().submit(input, options),
      },
    }),
    maxWorkers: 10,
    workerIdleTimeoutMs,
  });
  IngressEngine.setCoordinator(coordinator);

  const residentAgentResolver = {
    resolve: async (agentName: string, event: Ingress.InternalEvent) =>
      buildAgentDef(agentName, {
        systemProvider,
        agentProvider,
        mcpProvider,
        customProvider,
        defaultModel: { provider: services.model.providerID, id: services.model.id },
        providerOptions: configuredModel.providerOptions,
        workspaceRoot: event.workspace ?? workspaceRoot,
      }),
  };
  const owners = createServerDispatchOwners({
    coordinator,
    residentRuntime,
    credentials: services.connectorCredentials,
    secretRegistry: runtime.secrets,
    ledgerQueries: services.connectorQueries,
    ledgerTransitions: services.connectorTransitions,
    artifactWriter: services.connectorArtifacts,
    connectorEffects: services.effects,
    workspaceIdentity,
    waitKernel: services.waitKernel,
    authorityQueries: services.authorityQueries,
    model: services.model,
    residentAgentResolver,
  });
  const dispatchOptions = {
    owners,
    waitKernel: services.waitKernel,
    authorityQueries: services.authorityQueries,
    effects: services.effects,
    scheduleService: services.scheduleService,
    workerAttempts: services.workerAttempts,
    workerLedger: services.workerLedger,
  } satisfies DefaultDispatchRuntimeOptions;
  const sharedDispatchRuntime = createDefaultDispatchRuntime(dispatchOptions);
  dispatchRuntimeRef.current = sharedDispatchRuntime;
  agentProvider = new AgentToolProvider({
    ...dispatchOptions,
    workspaceIdentity,
    dispatchRuntime: sharedDispatchRuntime,
  });
  IngressEngine.setDispatchRuntime(sharedDispatchRuntime);
  IngressEngine.setAgentResolver(residentAgentResolver);

  const routingHandler = createRoutingHandler(
    systemProvider,
    agentProvider,
    mcpProvider,
    customProvider,
    workspaceRoot,
    { provider: services.model.providerID, id: services.model.id },
    services.ownerTaskQueries,
    services.modelCatalog,
    services.secretRegistry,
    services.modelCredential,
    services.modelEnvironment,
  );
  const { channels, wsHandler, githubWebhookHandler } = createChannelAdapters(
    config,
    routingHandler,
  );
  const traceId = crypto.randomUUID();
  await runRecovery(services.recovery, traceId);

  const app = createRouter({
    githubWebhookHandler,
    observability: { publish: services.events.publish },
    ...(config.server.wsToken
      ? {
          ownerProjection: {
            token: config.server.wsToken,
            queries: services.observabilityQueries,
          },
        }
      : {}),
  });
  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.host,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: Bun requires a websocket object.
    websocket: wsHandler?.ws ?? { open() {}, message() {} },
    fetch(req, serverInstance) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
        if (!wsHandler) return new Response("WebSocket unavailable", { status: 503 });
        return wsHandler.handleUpgrade(req, serverInstance) ?? new Response(null, { status: 101 });
      }
      return app.fetch(req, serverInstance);
    },
  });
  await Promise.all(channels.map((channel) => channel.start()));

  const cronRunner = services.cron.start({
    service: services.scheduleService,
    fire: (job, fire) => services.cron.fire(job, fire),
  });
  services.events.publish(Operational.BootstrapCompleted, {
    traceId,
    mode: "coordinator",
    channelCount: channels.length,
    time: Date.now(),
  });
  installShutdownHandlers({
    ingress: { stop: () => IngressEngine.reset() },
    channels,
    server,
    mcpProvider,
    coordinator,
    cronRunner,
    runtime,
    incidents,
    exit: process.exit,
  });
}

export { createProductionComposition } from "./kernel-services";
