import type { InboundWaitParams, InboundWaitResult } from "@openomni/coordinator";
import {
  DispatchRuntime,
  IngressEventProjector,
  IngressHandlers,
  type AgentToolProvider,
  type DispatchHandler,
  type ResidentRuntime,
  type SystemToolProvider,
} from "@openomni/openomni";
import { PendingAskStore, SurfaceKey, TraceContext, WorkerRun } from "@openomni/session";
import type { ServerConfig } from "../config";
import { buildResidentAgentDef } from "../ingress/bridge";
import type { CustomToolProvider } from "../tool/custom";
import type { McpToolProvider } from "../tool/mcp";

type ResidentInboundWaitModel = {
  readonly providerID: string;
  readonly id: string;
};

export type ResidentInboundWaitConfig = {
  readonly serverConfig: ServerConfig;
  readonly model?: ResidentInboundWaitModel;
  readonly residentRuntime: ResidentRuntime;
  readonly systemProvider: SystemToolProvider;
  readonly requireAgentProvider: () => AgentToolProvider;
  readonly mcpProvider: McpToolProvider;
  readonly customProvider: CustomToolProvider;
};

export function createResidentInboundWaitHandler(
  config: ResidentInboundWaitConfig,
): (params: InboundWaitParams) => Promise<InboundWaitResult> {
  return async ({ workerId, sessionId, runId, payload, workspaceRoot, signal }) => {
    const requestId = crypto.randomUUID();
    const resolvedWorkspace = workspaceRoot ?? config.serverConfig.workspace?.root ?? process.cwd();
    if (signal?.aborted) {
      return { requestId, accepted: false, error: "worker.inbound_wait aborted" };
    }
    const model = config.model;
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
      const residentHandler = createResidentAskHandler({
        ...config,
        model,
        sessionId,
        runId,
        workerId,
        mainSessionId,
        resolvedWorkspace,
      });
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
  };
}

type ResidentAskHandlerConfig = Omit<ResidentInboundWaitConfig, "model"> & {
  readonly model: ResidentInboundWaitModel;
  readonly sessionId: string;
  readonly runId?: string;
  readonly workerId: string;
  readonly mainSessionId: string;
  readonly resolvedWorkspace: string;
};

function createResidentAskHandler(config: ResidentAskHandlerConfig): DispatchHandler {
  return async (command, context) => {
    const surfaceKeys = SurfaceKey.listBySession(config.mainSessionId);
    const surfaceKey = surfaceKeys.length === 1 ? surfaceKeys[0] : undefined;
    const surface = surfaceKey ? SurfaceKey.parse(surfaceKey) : undefined;
    const tokenHash = typeof command.correlation === "string" ? command.correlation : undefined;
    PendingAskStore.create({
      id: command.dispatchId,
      originSessionId: config.sessionId,
      ...(config.runId ? { originRunId: config.runId } : {}),
      originActorKind: "worker",
      targetKind: "resident",
      ...(surface ? { endpointId: surface.namespace || surface.surface } : {}),
      ...(surface?.id ? { channelId: surface.id } : {}),
      correlation: {
        ...(tokenHash ? { tokenHash } : {}),
        ...(surfaceKey ? { externalConversationId: surfaceKey } : {}),
        ...(surface?.threadId ? { threadId: surface.threadId } : {}),
      },
    });
    try {
      const trace = command.traceId
        ? TraceContext.child({ traceId: command.traceId }, { sessionId: config.mainSessionId })
        : TraceContext.create({ sessionId: config.mainSessionId });
      const residentEvent = {
        id: command.dispatchId,
        surface: "dispatch",
        workspace: config.resolvedWorkspace,
        mode: "internal" as const,
        agentName: "resident",
        payload:
          typeof command.payload === "string" ? command.payload : JSON.stringify(command.payload),
        runtime: {
          durableSessionId: config.mainSessionId,
          lifecycle: "active" as const,
          ...(context?.signal ? { signal: context.signal } : {}),
        },
        target: { kind: "resident" as const, sessionId: config.mainSessionId },
        meta: {
          actor: {
            role: "worker",
            trusted: true,
            workerId: config.workerId,
            sessionId: config.sessionId,
            runId: config.runId,
          },
          target: { kind: "resident" as const, sessionId: config.mainSessionId },
          agentName: "resident",
        },
        agent: buildResidentAgentDef("resident", {
          systemProvider: config.systemProvider,
          agentProvider: config.requireAgentProvider(),
          mcpProvider: config.mcpProvider,
          customProvider: config.customProvider,
          defaultModel: {
            provider: config.model.providerID,
            id: config.model.id,
          },
          providerOptions: config.serverConfig.model?.providerOptions,
          workspaceRoot: config.resolvedWorkspace,
        }),
      };
      IngressEventProjector.project(
        residentEvent,
        config.mainSessionId,
        {
          providerID: config.model.providerID,
          modelID: config.model.id,
        },
        trace,
      );
      const result = await IngressHandlers.handleResident({
        sessionId: config.mainSessionId,
        event: residentEvent,
        residentRuntime: config.residentRuntime,
        traceContext: trace,
      });
      PendingAskStore.answer(command.dispatchId);
      return { output: result.result.output };
    } catch (error) {
      PendingAskStore.expire(command.dispatchId);
      throw error;
    }
  };
}
