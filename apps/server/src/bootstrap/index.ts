import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Gateway, Ingress } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { initialize, BusPersistence } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { newTraceId } from "@openomni/telemetry";
import {
  AgentToolProvider,
  createBrainEngine,
  createDefaultDispatchRuntime,
  createMessageSendTool,
  CronAdapter,
  CronJobRunner,
  ResidentRuntime,
  SystemToolProvider,
  type BrainEngine,
  type DispatchRuntime,
} from "@openomni/openomni";
import {
  createGatewayRouter,
  type ChannelDeliveryRoute,
  type GatewayRouter,
} from "@openomni/channels";
import { loadConfig } from "../config";
import { McpConfigLoader } from "../context/mcp-config";
import { createMessageHandler } from "../handler/conversation";
import { resolveRuntimeModel } from "../agents/model-resolution";
import { buildAgentDef, buildResidentAgentDef } from "../ingress/bridge";
import { buildToolDispatcher, createExecutionCoordinator } from "../execution/coordinator";
import { createRouter } from "../server/routes";
import { McpToolProvider } from "../tool/mcp";
import { CustomToolProvider } from "../tool/custom";
import { createChannelAdapters } from "./channels";
import { assembleEffectRuntime } from "./effects";
import { createServerDispatchOwners } from "./dispatch-owners";
import { registerServerMessaging, serverMessaging } from "./messaging";
import { connectMcpServers } from "./mcp";
import { runRecovery, startInboundSurfacesAfterRecovery } from "./recovery";
import { createResidentInboundWaitHandler } from "./resident-inbound-wait";
import { installShutdownHandlers } from "./shutdown";
import { registerAgent } from "../agents";
import { createResidentProfile } from "../profile/resident";
import { assembleBootstrap } from "./worker-bootstrap";

export interface MainOptions {
  /**
   * Absolute path to the worker entry script. The bundled CLI must inject the
   * dist-relative path because `import.meta.url` inside the bundle no longer
   * points at the source tree.
   */
  workerScript?: string;
}

export async function main(options: MainOptions = {}): Promise<void> {
  // Boot is a genuine trace origin — nothing precedes it to inherit from — and
  // it is ONE trace. Every line the boot emits carries it, so a failed startup
  // reads as a single sequence instead of eight unrelated records.
  const bootTraceId = newTraceId();
  // Persistence needs the dbPath FROM config, so config loads first — but
  // everything it publishes (malformed config.json → defaults, rejected
  // grants/MCP entries) would land in a subscriber-less Bus and vanish.
  // Buffer the pre-persistence window and republish once the journal is up.
  const preBootEvents: Array<Parameters<typeof Bus.publish>> = [];
  const stopBuffering = Bus.observe((descriptor, data) => {
    preBootEvents.push([descriptor, data] as Parameters<typeof Bus.publish>);
  });
  const config = loadConfig(bootTraceId);
  if (process.env.OPENOMNI_MODE === "local") {
    throw new Error("OPENOMNI_MODE=local is disabled; OpenOmni requires coordinator mode");
  }

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  const completionWriter = initialize({ dbPath: config.storage.dbPath });
  BusPersistence.start();
  // Observer delivery is microtask-queued: without this turn the buffer is
  // provably EMPTY at the republish (the #676 review demonstrated it live).
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  stopBuffering();
  for (const [descriptor, data] of preBootEvents) Bus.publish(descriptor, data);
  preBootEvents.length = 0;

  const systemProvider = new SystemToolProvider(config.workspace?.root);
  const agentProviderRef: { current?: AgentToolProvider } = {};
  const requireAgentProvider = (): AgentToolProvider => {
    if (!agentProviderRef.current) throw new Error("agent tool provider is not configured");
    return agentProviderRef.current;
  };
  const mcpProvider = new McpToolProvider({ traceId: bootTraceId });

  const projectMcpServers = McpConfigLoader.discover(
    config.workspace?.root ?? process.cwd(),
    bootTraceId,
  );
  const mergedMcpConfig = {
    ...config.mcp,
    servers: McpConfigLoader.merge(config.mcp.servers, projectMcpServers),
  };
  await connectMcpServers({ ...config, mcp: mergedMcpConfig }, mcpProvider, bootTraceId);

  const residentRuntime = ResidentRuntime.create({
    maxActive: 10,
    idleTimeoutMs: Number(process.env.OPENOMNI_RESIDENT_IDLE_TIMEOUT_MS ?? 30_000),
  });

  Bus.publish(Operational.Events.Info, {
    traceId: bootTraceId,
    time: Date.now(),
    component: "server",
    msg: "server running in coordinator mode",
  });
  const workerScript =
    options.workerScript ?? join(import.meta.dir, "../execution/worker-entry.ts");
  const customProvider = new CustomToolProvider();
  const bootstrap = await assembleBootstrap(mcpProvider, undefined, customProvider);
  const hasAnyChannel = Boolean(
    config.telegram.token || config.github.secret || config.discord.token,
  );
  const model = await resolveModel(bootTraceId, config);
  const residentProfile = model
    ? await createResidentProfile({ model: { provider: model.providerID, id: model.id } })
    : undefined;
  if (residentProfile) registerAgent(residentProfile.factory, residentProfile.metadata);
  const toolDispatcher = buildToolDispatcher([mcpProvider, customProvider]);
  const dispatchRuntimeRef: { current?: DispatchRuntime } = {};
  const requireDispatchRuntime = (): DispatchRuntime => {
    if (!dispatchRuntimeRef.current) throw new Error("dispatch runtime is not configured");
    return dispatchRuntimeRef.current;
  };
  const coordinator = createExecutionCoordinator({
    workerScript,
    bootstrap,
    toolDispatcher,
    askResident: createResidentInboundWaitHandler({
      serverConfig: config,
      dispatchRuntime: {
        submit: (input, options) => requireDispatchRuntime().submit(input, options),
      },
    }),
    maxWorkers: 10,
    workerIdleTimeoutMs: Number(process.env.OPENOMNI_WORKER_IDLE_TIMEOUT_MS ?? 30_000),
  });
  const residentAgentResolver = {
    resolve: async (agentName: string, event: Ingress.InternalEvent) =>
      buildAgentDef(agentName, {
        systemProvider,
        agentProvider: requireAgentProvider(),
        mcpProvider,
        customProvider,
        defaultModel: model ? { provider: model.providerID, id: model.id } : undefined,
        providerOptions: config.model?.providerOptions,
        workspaceRoot: event.workspace ?? config.workspace?.root ?? process.cwd(),
      }),
  };
  // The brain engine and the dispatch runtime reference each other at
  // command time (resident.ask executes through the engine; the engine
  // executes pending-interaction deliveries through the runtime), so the
  // dispatch side receives the engine through the same fail-closed ref seam
  // as the runtime above.
  const ingressEngineRef: { current?: BrainEngine } = {};
  const requireIngressEngine = (): BrainEngine => {
    if (!ingressEngineRef.current) throw new Error("ingress engine is not configured");
    return ingressEngineRef.current;
  };
  const dispatchOwners = createServerDispatchOwners({
    coordinator,
    residentRuntime,
    credentials: bootstrap.credentials,
    model,
    residentAgentResolver,
    ingress: {
      ingestInternal: (event, runtime) => requireIngressEngine().ingestInternal(event, runtime),
    },
  });
  const sharedDispatchRuntime = createDefaultDispatchRuntime({
    completionWriter,
    owners: dispatchOwners,
  });
  agentProviderRef.current = new AgentToolProvider({
    dispatchRuntime: sharedDispatchRuntime,
  });
  // #708: the brain's as-me outbound trigger. The send port is the server's
  // registered messaging seam (lazy: registration happens after the router
  // composes below; a call before that keeps the typed fail-closed error).
  // Default posture: the tool is cataloged (delegation category — the depth
  // gate keeps it resident-only), but authority stays with the Owner: no
  // `messaging.personaActorId` → typed "persona not configured" result, and
  // grants default empty → every send denied `ungranted`.
  agentProviderRef.current.register(
    createMessageSendTool({
      send: (input) => serverMessaging().send(input),
      ...(config.messaging.personaActorId === undefined
        ? {}
        : { personaActorId: config.messaging.personaActorId }),
    }),
  );
  dispatchRuntimeRef.current = sharedDispatchRuntime;
  // #707: the brain's Deliver consumer resolves the resident AgentDef itself —
  // the SAME construction the channel bridge used to embed per message
  // (buildResidentAgentDef + per-message runtime model resolution), relocated
  // behind the injected resolver.
  const externalAgentResolver = model
    ? async (event: Gateway.DeliveredEvent): Promise<Ingress.AgentDef> => {
        const defaultModel = { provider: model.providerID, id: model.id };
        const agentDef = buildResidentAgentDef({
          systemProvider,
          agentProvider: requireAgentProvider(),
          mcpProvider,
          customProvider,
          defaultModel,
          providerOptions: config.model?.providerOptions,
          workspaceRoot: config.workspace?.root ?? process.cwd(),
        });
        agentDef.model = await resolveRuntimeModel(agentDef.model, event.traceId, defaultModel);
        return agentDef;
      }
    : undefined;
  // The engine claims internal (cron-stickiness) surface sessions through
  // the gateway router's port (#708); the router is composed just below, so
  // the claim crosses the same fail-closed ref seam as the other cycles.
  const gatewayRouterRef: { current?: GatewayRouter } = {};
  const ingressEngine = createBrainEngine({
    coordinator,
    residentRuntime,
    agentResolver: residentAgentResolver,
    dispatchRuntime: sharedDispatchRuntime,
    ...(externalAgentResolver === undefined ? {} : { externalAgentResolver }),
    claimSurface: (surfaceKey, sessionId, expectedSessionId) => {
      if (!gatewayRouterRef.current) {
        throw new Error("gateway router is not configured — surface claims fail closed");
      }
      return gatewayRouterRef.current.claimSurface(surfaceKey, sessionId, expectedSessionId);
    },
  });
  ingressEngineRef.current = ingressEngine;

  // Gateway router (#707 stage 2): perimeter routing + wait service + the
  // #215 send kernel live in @openomni/channels; apps/server only composes.
  // The delivery-route map is created here and populated by the channel
  // adapters below — the router reads it at send time, so sends before any
  // adapter registers keep the same fail-closed missing-surface error.
  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
  const gatewayRouter = createGatewayRouter({
    sink: Bus.publish,
    deliver: ingressEngine.deliver,
    messaging: {
      deliveryRoutes,
      grants: () => config.messaging.grants,
      replyGrantRules: () => config.messaging.replyGrantRules,
    },
  });
  gatewayRouterRef.current = gatewayRouter;

  const routingHandler = model ? createMessageHandler({ ingress: gatewayRouter }) : undefined;

  if (model) {
    Bus.publish(Operational.Events.Info, {
      traceId: bootTraceId,
      time: Date.now(),
      component: "server",
      msg: `server using model: ${model.providerID}/${model.id}`,
    });
  } else {
    Bus.publish(Operational.Events.Warn, {
      traceId: bootTraceId,
      time: Date.now(),
      component: "server",
      msg: "server no model credentials found; realtime surfaces disabled",
    });
  }

  const { channels, wsHandler, githubWebhookHandler } = createChannelAdapters(
    config,
    routingHandler,
    deliveryRoutes,
  );
  // Existing-agent messaging (#215, kernel in the gateway router since #707):
  // the router composed the send kernel over the delivery-route map above;
  // this registers it as the server's fail-closed send seam. Grants default
  // to the empty list — granting requires explicit `messaging.grants`
  // configuration.
  registerServerMessaging({
    messaging: gatewayRouter.messaging,
    channels: [...deliveryRoutes.keys()],
    grantsConfigured: config.messaging.grants.length,
    traceId: bootTraceId,
  });

  if (hasAnyChannel && !routingHandler) {
    Bus.publish(Operational.Events.Warn, {
      traceId: bootTraceId,
      time: Date.now(),
      component: "server",
      msg: "server channel credentials found but no model credentials; channels disabled",
    });
  }

  const traceId = bootTraceId;
  const mode = "coordinator";
  // #492: manifest composition + finish reconciliation + admin drive surface.
  const effectRuntime = assembleEffectRuntime();
  const app = createRouter(githubWebhookHandler, {
    observabilityToken: config.server.wsToken,
    // #510 D3: read-only ledger inspection; denies 401 until
    // OPENOMNI_ADMIN_TOKEN (or server.adminToken) is configured.
    adminToken: config.server.adminToken,
    // D2a artifact convention: the manifest lives beside the database file.
    ledgerArchiveManifestPath: join(dirname(config.storage.dbPath), "ledger-archive-manifest.json"),
    effects: { service: effectRuntime.service, reconciler: effectRuntime.reconciler },
  });
  const server = await startInboundSurfacesAfterRecovery({
    recover: () =>
      runRecovery({
        handler: routingHandler,
        coordinator,
        traceId,
        completionRuntime: sharedDispatchRuntime,
        effects: effectRuntime.reconciler,
      }),
    createServer: () =>
      Bun.serve({
        port: config.server.port,
        hostname: config.server.host,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: Bun.serve requires a websocket object; these are intentional no-ops when WS is disabled
        websocket: wsHandler?.ws ?? { open() {}, message() {} },
        fetch(req, serverInstance) {
          const url = new URL(req.url);
          if (req.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
            if (!wsHandler) {
              return new Response("WebSocket unavailable", { status: 503 });
            }
            const response = wsHandler.handleUpgrade(req, serverInstance);
            return response ?? new Response(null, { status: 101 });
          }
          return app.fetch(req, serverInstance);
        },
      }),
    channels,
    traceId: bootTraceId,
  });

  if (channels.length === 0) {
    Bus.publish(Operational.Events.Info, {
      traceId: bootTraceId,
      time: Date.now(),
      component: "server",
      msg: "server no external channels configured; web and websocket endpoints only",
    });
  }

  Bus.publish(Operational.Events.Info, {
    traceId: bootTraceId,
    time: Date.now(),
    component: "server",
    msg: `server listening on http://${config.server.host}:${server.port}`,
  });
  Bus.publish(Operational.Events.Info, {
    traceId: bootTraceId,
    time: Date.now(),
    component: "server",
    msg: `server websocket endpoint ready at ws://${config.server.host}:${server.port}/ws`,
  });

  const cronRunner = CronJobRunner.start({
    fire: async (job, jobTraceId) => {
      await CronAdapter.fire(job, ingressEngine, jobTraceId);
    },
  });

  Bus.publish(Operational.Events.BootstrapCompleted, {
    traceId,
    mode,
    channelCount: channels.length,
    time: Date.now(),
  });

  installShutdownHandlers({
    channels,
    server,
    mcpProvider,
    coordinator,
    cronRunner,
    traceId,
  });
}

// merged from providers.ts (#453 hygiene: sub-30-LOC single-importer)
import { resolveDefaultProviderModel } from "../agents/model-resolution";
import type { ServerConfig } from "../config";

async function resolveModel(traceId: string, config?: ServerConfig) {
  if (config?.model) {
    return { providerID: config.model.provider, id: config.model.id, name: config.model.id };
  }
  return resolveDefaultProviderModel(traceId);
}
