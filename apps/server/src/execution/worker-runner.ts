import { ChatAgent } from "@openomni/agent";
import {
  AgentToolProvider,
  SystemToolProvider,
  buildWorkerMiddleware,
  createChildAgentRuntime,
  createChildAgentTool,
} from "@openomni/openomni";
import type { NativeTool } from "@openomni/openomni";
import { Execution } from "@openomni/protocol";
import { createContextMiddleware } from "../context/index";
import {
  publishWorkerRunCancelled,
  publishWorkerRunFailed,
  publishWorkerRunStarted,
  publishWorkerRunSucceeded,
} from "./worker-runner-events";
import {
  createMcpProxyProvider,
  createWorkerDispatchRuntime,
  notifyWorkerRunCompleted,
} from "./worker-runner-ipc";
import { respondSpawnRejected, type WorkerRunnerSpawnOptions } from "./worker-runner-types";
import {
  buildWorkerInputMessages,
  createExecutionToolContext,
  selectRequestedTools,
} from "./worker-runtime";

export namespace WorkerRunner {
  export function spawnRun(options: WorkerRunnerSpawnOptions): void {
    const {
      params,
      ipcAuthToken,
      server,
      activeRuns,
      bootstrapReady,
      injectionQueue,
      defaultWorkspaceRoot,
      getBootstrap,
      resolveAuth,
      respond,
      createAgent = ChatAgent.create,
    } = options;

    if (params?.authToken !== ipcAuthToken) {
      respondSpawnRejected({ params, respond, error: "unauthorized coordinator request" });
      return;
    }

    let request: Execution.Request;
    try {
      request = Execution.Request.parse(params);
    } catch (err) {
      respondSpawnRejected({
        params,
        respond,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const { runId, sessionId } = request;
    if (activeRuns.has(runId)) {
      respond({
        runId,
        sessionId,
        status: "failed",
        error: `run already active: ${runId}`,
      });
      return;
    }

    (async () => {
      const traceId = request.traceId ?? crypto.randomUUID();
      const controller = new AbortController();
      let childAgentRuntime: ReturnType<typeof createChildAgentRuntime> | undefined;

      try {
        activeRuns.set(runId, { sessionId, controller });
        server.notify("worker.run_started", { runId, sessionId });
        publishWorkerRunStarted({ traceId, sessionId, runId, prompt: request.prompt });
        await bootstrapReady;
        const bootstrap = getBootstrap();
        const messages = buildWorkerInputMessages(sessionId, request.prompt);
        const workspaceRoot =
          request.workspaceRoot ?? request.toolConfig?.workspaceRoot ?? defaultWorkspaceRoot;
        const systemProvider = new SystemToolProvider(workspaceRoot);

        const mcpProxyProvider = createMcpProxyProvider({
          toolCatalog: bootstrap?.toolCatalog ?? [],
          server,
          runId,
          sessionId,
          ...(workspaceRoot ? { workspaceRoot } : {}),
        });

        const agentProvider = new AgentToolProvider({
          dispatchToolMode: "worker-resident-ask",
          dispatchRuntime: createWorkerDispatchRuntime({
            server,
            ipcAuthToken,
            workerId: options.workerId,
            sessionId,
            runId,
            ...(workspaceRoot ? { workspaceRoot } : {}),
          }),
        });

        const systemTools = systemProvider.listTools();
        const proxyTools = mcpProxyProvider.listTools();
        let childParentTools: readonly NativeTool[] = [];
        const middleware = [
          createContextMiddleware({ workspaceRoot: workspaceRoot ?? process.cwd() }),
          ...buildWorkerMiddleware({
            permissions: request.permissions,
            injectionQueue,
            ...(request.policyPlan ? { policyPlan: request.policyPlan } : {}),
          }),
        ];
        childAgentRuntime = createChildAgentRuntime({
          model: request.model,
          systemPrompt: request.systemPrompt,
          parentMessages: messages,
          parentTools: () => childParentTools,
          ...(workspaceRoot ? { workspaceRoot } : {}),
          traceContext: { traceId, sessionId, runId },
          parentSignal: controller.signal,
          auth: resolveAuth(request.model.provider),
          allowAuthFallback: false,
          ...(request.budget ? { budget: request.budget } : {}),
          ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
          middleware,
          createAgent,
        });
        agentProvider.register(createChildAgentTool(childAgentRuntime));
        const agentTools = agentProvider.listTools();
        const availableTools = [...systemTools, ...agentTools, ...proxyTools];
        childParentTools = selectRequestedTools(availableTools, request.tools).filter(
          (tool) => tool.spec.name !== "child_agent",
        );
        const { tools, toolExecutor } = createExecutionToolContext(
          {
            ...request,
            toolConfig: {
              ...(request.toolConfig ?? {}),
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          },
          availableTools,
        );
        const exposedTools = tools ?? [];

        const agent = createAgent({
          model: request.model,
          auth: resolveAuth(request.model.provider),
          allowAuthFallback: false,
          signal: controller.signal,
          budget: request.budget,
          systemPrompt: [
            request.systemPrompt,
            "Worker runtime tools: use dispatch action resident.ask with wait: true to ask the Resident for guidance or approval; responses from other agents arrive automatically, no polling needed.",
            "When child_agent is available, use it only for lightweight parallel work inside this worker run; child agents inherit this worker context and cannot delegate further.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          tools: exposedTools,
          toolExecutor,
          ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
          middleware,
        });
        const runResult = await agent.run({
          messages,
          traceContext: { traceId, sessionId, runId },
        });
        if (controller.signal.aborted) {
          notifyWorkerRunCompleted(server, {
            runId,
            sessionId,
            status: "cancelled",
          });
          publishWorkerRunCancelled({ traceId, sessionId, runId });

          respond({
            runId,
            sessionId,
            status: "cancelled",
            error: "cancelled by coordinator",
          });
          return;
        }

        notifyWorkerRunCompleted(server, {
          runId,
          sessionId,
          status: "succeeded",
          output: runResult.text,
        });
        publishWorkerRunSucceeded({ traceId, sessionId, runId });

        respond({
          runId,
          sessionId,
          status: "succeeded",
          output: runResult.text,
          finishReason: runResult.finishReason,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const wasCancelled = controller.signal.aborted;
        if (wasCancelled) {
          notifyWorkerRunCompleted(server, {
            runId,
            sessionId,
            status: "cancelled",
            error: errorMessage,
          });
          publishWorkerRunCancelled({ traceId, sessionId, runId });

          respond({
            runId,
            sessionId,
            status: "cancelled",
            error: errorMessage,
          });
          return;
        }
        notifyWorkerRunCompleted(server, {
          runId,
          sessionId,
          status: "failed",
          error: errorMessage,
        });
        publishWorkerRunFailed({ traceId, sessionId, runId, errorMessage });

        respond({
          runId,
          sessionId,
          status: "failed",
          error: errorMessage,
        });
      } finally {
        childAgentRuntime?.cancelAll();
        injectionQueue.dispose(runId);
        activeRuns.delete(runId);
      }
    })();
  }
}
