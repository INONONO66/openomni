import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import {
  initialize,
  Bus,
  BusPersistence,
  PendingAskStore,
  SurfaceKey,
  TraceContext,
  WorkerRun,
} from "@openomni/session";
import {
  AgentToolProvider,
  CronAdapter,
  CronJobRunner,
  DispatchRuntime,
  IngressEngine,
  IngressEventProjector,
  IngressHandlers,
  ResidentRuntime,
  SystemToolProvider,
  resolveCategory,
  type DispatchHandler,
} from "@openomni/openomni";
import { Auth } from "@openomni/llm";
import { loadConfig } from "../config";
import { McpConfigLoader } from "../context/index";
import { createMessageHandler } from "../handler/conversation";
import { buildAgentDef, buildResidentAgentDef } from "../ingress/bridge";
import { buildToolDispatcher, createExecutionCoordinator } from "../execution/coordinator";
import { createRouter } from "../server/routes";
import { McpToolProvider } from "../tool/mcp";
import { CustomToolProvider } from "../tool/custom";
import { createChannelAdapters } from "./channels";
import { connectMcpServers } from "./mcp";
import { resolveModel } from "./providers";
import { runRecovery } from "./recovery";
import { installShutdownHandlers } from "./shutdown";
import { createAllAgents, registerAgent } from "../agents";
import { RuntimeAgentDefinition } from "../agents/runtime-definition";
import { createResidentProfile } from "../profile/resident";

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

async function assembleBootstrap(mcpProvider: McpToolProvider): Promise<WorkerBootstrap.Bootstrap> {
  const agents = [...createAllAgents().values()].map(RuntimeAgentDefinition.create);

  const toolCatalog = mcpProvider.listTools().map(
    (tool): WorkerBootstrap.RuntimeToolCatalogEntry => ({
      canonicalName: tool.spec.name,
      exposedName: tool.spec.name,
      source: "mcp",
      category: resolveCategory(tool.spec.name, "mcp", tool.category),
      riskTier: tool.riskTier,
      spec: tool.spec,
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
      mcpServer: tool.spec.name.includes(".") ? tool.spec.name.split(".")[0] : undefined,
    }),
  );

  const authEntries = await Auth.all();
  const credentials: Record<string, string> = {};
  for (const [provider, entry] of Object.entries(authEntries)) {
    const prefix = provider.toUpperCase();
    if (entry.type === "api") {
      credentials[`${prefix}_API_KEY`] = entry.key;
    } else if (entry.type === "proxy") {
      credentials[`${prefix}_BASE_URL`] = entry.baseURL;
      if (entry.apiKey) credentials[`${prefix}_API_KEY`] = entry.apiKey;
    }
  }

  const epochInput = [
    ...agents.map((a) => a.name).sort(),
    ...toolCatalog.map((t) => t.canonicalName).sort(),
  ].join(",");
  const configEpoch = djb2Hash(epochInput);

  return { configEpoch, agents, toolCatalog, credentials };
}

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

export async function main(): Promise<void> {
  const config = loadConfig();
  if (process.env.OPENOMNI_MODE === "local") {
    throw new Error("OPENOMNI_MODE=local is disabled; OpenOmni requires coordinator mode");
  }

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  initialize({ dbPath: config.storage.dbPath });
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
  const workerScript = new URL("../execution/worker-entry.ts", import.meta.url).pathname;
  const bootstrap = await assembleBootstrap(mcpProvider);
  const hasAnyChannel = Boolean(
    config.telegram.token || config.github.secret || config.discord.token,
  );
  const model = await resolveModel(config);
  const residentProfile = model
    ? await createResidentProfile({ model: { provider: model.providerID, id: model.id } })
    : undefined;
  if (residentProfile) registerAgent(residentProfile.factory, residentProfile.metadata);
  const customProvider = new CustomToolProvider();
  const toolDispatcher = buildToolDispatcher([mcpProvider]);
  const coordinator = createExecutionCoordinator({
    workerScript,
    bootstrap,
    toolDispatcher,
    askResident: async ({ workerId, sessionId, runId, payload, workspaceRoot, signal }) => {
      const requestId = crypto.randomUUID();
      const resolvedWorkspace = workspaceRoot ?? config.workspace?.root ?? process.cwd();
      if (signal?.aborted) {
        return { requestId, accepted: false, error: "worker.inbound_wait aborted" };
      }
      if (!model) {
        return {
          requestId,
          accepted: false,
          error: "worker.inbound_wait requires a configured model",
        };
      }
      const run = runId ? await WorkerRun.get(sessionId, runId) : undefined;
      const mainSessionId = run?.parentSessionId;
      if (!mainSessionId) {
        return {
          requestId,
          accepted: false,
          error: `worker.inbound_wait requires a worker run with parent Resident session: ${runId ?? "unknown"}`,
        };
      }

      const current = runId ? await WorkerRun.get(sessionId, runId) : undefined;
      if (runId && current && current.status === "starting") {
        await WorkerRun.updateStatus(sessionId, runId, "running");
      }
      const running = runId ? await WorkerRun.get(sessionId, runId) : undefined;
      if (runId && running?.status === "running") {
        await WorkerRun.updateStatus(sessionId, runId, "waiting_input");
      }

      try {
        const residentPayload = `Worker ${workerId}${runId ? ` run ${runId}` : ""} asks Resident:\n\n${payload}`;
        const residentHandler: DispatchHandler = async (command, context) => {
          const surfaceKeys = SurfaceKey.listBySession(mainSessionId);
          const surfaceKey = surfaceKeys.length === 1 ? surfaceKeys[0] : undefined;
          const surface = surfaceKey ? SurfaceKey.parse(surfaceKey) : undefined;
          PendingAskStore.create({
            id: command.dispatchId,
            originSessionId: sessionId,
            ...(runId ? { originRunId: runId } : {}),
            originActorKind: "worker",
            targetKind: "resident",
            ...(surface ? { endpointId: surface.namespace || surface.surface } : {}),
            ...(surface?.id ? { channelId: surface.id } : {}),
            correlation: {
              ...(command.correlation ? { tokenHash: command.correlation } : {}),
              ...(surfaceKey ? { externalConversationId: surfaceKey } : {}),
              ...(surface?.threadId ? { threadId: surface.threadId } : {}),
            },
          });
          try {
            const trace = command.traceId
              ? TraceContext.child({ traceId: command.traceId }, { sessionId: mainSessionId })
              : TraceContext.create({ sessionId: mainSessionId });
            const residentEvent = {
              id: command.dispatchId,
              surface: "dispatch",
              workspace: resolvedWorkspace,
              mode: "internal" as const,
              agentName: "resident",
              payload:
                typeof command.payload === "string"
                  ? command.payload
                  : JSON.stringify(command.payload),
              runtime: {
                durableSessionId: mainSessionId,
                lifecycle: "active" as const,
                ...(context?.signal ? { signal: context.signal } : {}),
              },
              target: { kind: "resident" as const, sessionId: mainSessionId },
              meta: {
                actor: {
                  role: "worker",
                  trusted: true,
                  workerId,
                  sessionId,
                  runId,
                },
                target: { kind: "resident" as const, sessionId: mainSessionId },
                agentName: "resident",
              },
              agent: buildResidentAgentDef("resident", {
                systemProvider,
                agentProvider: requireAgentProvider(),
                mcpProvider,
                customProvider,
                defaultModel: { provider: model.providerID, id: model.id },
                providerOptions: config.model?.providerOptions,
                workspaceRoot: resolvedWorkspace,
              }),
            };
            IngressEventProjector.project(
              residentEvent,
              mainSessionId,
              { providerID: model.providerID, modelID: model.id },
              trace,
            );
            const result = await IngressHandlers.handleResident({
              sessionId: mainSessionId,
              event: residentEvent,
              residentRuntime,
              traceContext: trace,
            });
            PendingAskStore.answer(command.dispatchId);
            return { output: result.result.output };
          } catch (error) {
            PendingAskStore.expire(command.dispatchId);
            throw error;
          }
        };

        const dispatchRuntime = new DispatchRuntime();
        dispatchRuntime.register("resident.ask", residentHandler);
        const dispatchResult = await dispatchRuntime.submit(
          {
            action: "resident.ask",
            target: { kind: "resident", sessionId: mainSessionId },
            payload: residentPayload,
            wait: true,
            correlation: requestId,
          },
          {
            sessionId,
            ...(runId ? { runId } : {}),
            actorKind: "worker",
            actorId: `${sessionId}:${runId ?? workerId}`,
            agentName: "worker",
            trustTier: "assigned_worker",
            workspaceRoot: resolvedWorkspace,
            ...(signal ? { signal } : {}),
          },
        );
        if (dispatchResult.status !== "completed") {
          return {
            requestId,
            accepted: false,
            error:
              dispatchResult.error ??
              dispatchResult.reason ??
              `worker.inbound_wait dispatch ${dispatchResult.status}`,
          };
        }
        return {
          requestId,
          accepted: true,
          output: typeof dispatchResult.output === "string" ? dispatchResult.output : "",
        };
      } finally {
        const after = runId ? await WorkerRun.get(sessionId, runId) : undefined;
        if (runId && after?.status === "waiting_input") {
          await WorkerRun.updateStatus(sessionId, runId, "running");
        }
      }
    },
    maxWorkers: 10,
    workerIdleTimeoutMs: Number(process.env.OPENOMNI_WORKER_IDLE_TIMEOUT_MS ?? 30_000),
  });
  IngressEngine.setCoordinator(coordinator);
  agentProviderRef.current = new AgentToolProvider({
    dispatchOwners: {
      coordinator,
      residentRuntime,
      ...(model ? { defaultModel: { provider: model.providerID, id: model.id } } : {}),
    },
  });
  IngressEngine.setAgentResolver({
    resolve: async (agentName, event) =>
      buildAgentDef(agentName, {
        systemProvider,
        agentProvider: requireAgentProvider(),
        mcpProvider,
        customProvider,
        defaultModel: model ? { provider: model.providerID, id: model.id } : undefined,
        providerOptions: config.model?.providerOptions,
        workspaceRoot: event.workspace ?? config.workspace?.root ?? process.cwd(),
      }),
  });

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

  const { channels, wsHandler, githubWebhookHandler } = createChannelAdapters(
    config,
    routingHandler,
  );

  if (hasAnyChannel && !routingHandler) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "server channel credentials found but no model credentials; channels disabled",
    });
  }

  const app = createRouter(githubWebhookHandler, {
    observabilityToken: config.server.wsToken,
  });
  const server = Bun.serve({
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
  });

  await Promise.all(channels.map((channel) => channel.start()));

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

  const traceId = crypto.randomUUID();
  const mode = "coordinator";
  await runRecovery(routingHandler, coordinator, traceId);
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
