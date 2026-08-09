import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, Ingress } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { initialize, Bus, BusPersistence } from "@openomni/session";
import {
  AgentToolProvider,
  createDefaultDispatchRuntime,
  CronAdapter,
  CronJobRunner,
  IngressEngine,
  ResidentRuntime,
  SystemToolProvider,
  type DispatchRuntime,
} from "@openomni/openomni";
import { loadConfig } from "../config";
import { McpConfigLoader } from "../context/index";
import { createMessageHandler } from "../handler/conversation";
import { buildAgentDef } from "../ingress/bridge";
import { buildToolDispatcher, createExecutionCoordinator } from "../execution/coordinator";
import { createRouter } from "../server/routes";
import { McpToolProvider } from "../tool/mcp";
import { CustomToolProvider } from "../tool/custom";
import { createChannelAdapters } from "./channels";
import { createServerDispatchOwners } from "./dispatch-owners";
import { registerServerMessaging } from "./messaging";
import { connectMcpServers } from "./mcp";
import { runRecovery, startInboundSurfacesAfterRecovery } from "./recovery";
import { createResidentInboundWaitHandler } from "./resident-inbound-wait";
import { installShutdownHandlers } from "./shutdown";
import { registerAgent } from "../agents";
import { createResidentProfile } from "../profile/resident";
import { assembleBootstrap } from "./worker-bootstrap";

function createRoutingHandler(
  systemProvider: SystemToolProvider,
  agentProvider: AgentToolProvider,
  mcpProvider: McpToolProvider,
  workspaceRoot: string,
  defaultModel?: { provider: string; id: string },
  customProvider?: CustomToolProvider,
): Adapter.MessageHandler {
  return createMessageHandler({
    systemProvider,
    agentProvider,
    mcpProvider,
    customProvider,
    defaultModel,
    workspaceRoot,
  });
}

export interface MainOptions {
  /**
   * Absolute path to the worker entry script. The bundled CLI must inject the
   * dist-relative path because `import.meta.url` inside the bundle no longer
   * points at the source tree.
   */
  workerScript?: string;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const config = loadConfig();
  if (process.env.OPENOMNI_MODE === "local") {
    throw new Error("OPENOMNI_MODE=local is disabled; OpenOmni requires coordinator mode");
  }

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  const completionWriter = initialize({ dbPath: config.storage.dbPath });
  BusPersistence.start();

  const systemProvider = new SystemToolProvider(config.workspace?.root);
  const agentProviderRef: { current?: AgentToolProvider } = {};
  const requireAgentProvider = (): AgentToolProvider => {
    if (!agentProviderRef.current) throw new Error("agent tool provider is not configured");
    return agentProviderRef.current;
  };
  const mcpProvider = new McpToolProvider();

  const projectMcpServers = McpConfigLoader.discover(config.workspace?.root ?? process.cwd());
  const mergedMcpConfig = {
    ...config.mcp,
    servers: McpConfigLoader.merge(config.mcp.servers, projectMcpServers),
  };
  await connectMcpServers({ ...config, mcp: mergedMcpConfig }, mcpProvider);

  const residentRuntime = ResidentRuntime.create({
    maxActive: 10,
    idleTimeoutMs: Number(process.env.OPENOMNI_RESIDENT_IDLE_TIMEOUT_MS ?? 30_000),
  });
  IngressEngine.setResidentRuntime(residentRuntime);

  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
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
  const model = await resolveModel(config);
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
  IngressEngine.setCoordinator(coordinator);
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
  const dispatchOwners = createServerDispatchOwners({
    coordinator,
    residentRuntime,
    credentials: bootstrap.credentials,
    model,
    residentAgentResolver,
  });
  const sharedDispatchRuntime = createDefaultDispatchRuntime({
    completionWriter,
    owners: dispatchOwners,
  });
  agentProviderRef.current = new AgentToolProvider({
    dispatchRuntime: sharedDispatchRuntime,
  });
  dispatchRuntimeRef.current = sharedDispatchRuntime;
  IngressEngine.setDispatchRuntime(sharedDispatchRuntime);
  IngressEngine.setAgentResolver(residentAgentResolver);

  const routingHandler = model
    ? createRoutingHandler(
        systemProvider,
        requireAgentProvider(),
        mcpProvider,
        config.workspace?.root ?? process.cwd(),
        { provider: model.providerID, id: model.id },
        customProvider,
      )
    : undefined;

  if (model) {
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: `server using model: ${model.providerID}/${model.id}`,
    });
  } else {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server no model credentials found; realtime surfaces disabled",
    });
  }

  const { channels, wsHandler, githubWebhookHandler, deliveryRoutes } = createChannelAdapters(
    config,
    routingHandler,
  );
  // Existing-agent messaging (#215): the concrete channel delivery owner is
  // composed here, behind the kernel's injected-owner fail-closed seam.
  // Grants default to the empty list — granting requires explicit
  // `messaging.grants` configuration.
  registerServerMessaging({ deliveryRoutes, grants: config.messaging.grants });

  if (hasAnyChannel && !routingHandler) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server channel credentials found but no model credentials; channels disabled",
    });
  }

  const traceId = crypto.randomUUID();
  const mode = "coordinator";
  const app = createRouter(githubWebhookHandler, {
    observabilityToken: config.server.wsToken,
    // #510 D3: read-only ledger inspection; denies 401 until
    // OPENOMNI_ADMIN_TOKEN (or server.adminToken) is configured.
    adminToken: config.server.adminToken,
    // D2a artifact convention: the manifest lives beside the database file.
    ledgerArchiveManifestPath: join(dirname(config.storage.dbPath), "ledger-archive-manifest.json"),
  });
  const server = await startInboundSurfacesAfterRecovery({
    recover: () =>
      runRecovery({
        handler: routingHandler,
        coordinator,
        traceId,
        completionRuntime: sharedDispatchRuntime,
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
  });

  if (channels.length === 0) {
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server no external channels configured; web and websocket endpoints only",
    });
  }

  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: `server listening on http://${config.server.host}:${server.port}`,
  });
  Bus.publish(Operational.Info, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: `server websocket endpoint ready at ws://${config.server.host}:${server.port}/ws`,
  });

  const cronRunner = CronJobRunner.start({
    fire: async (job) => {
      await CronAdapter.fire(job);
    },
  });

  Bus.publish(Operational.BootstrapCompleted, {
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

async function resolveModel(config?: ServerConfig) {
  if (config?.model) {
    return { providerID: config.model.provider, id: config.model.id, name: config.model.id };
  }
  return resolveDefaultProviderModel();
}
