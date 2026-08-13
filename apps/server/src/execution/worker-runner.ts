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
import { TranscriptStore } from "@openomni/session";
import { createContextMiddleware } from "../context/middleware";
import {
  publishWorkerRunCancelled,
  publishWorkerRunFailed,
  publishWorkerRunStarted,
  publishWorkerRunSucceeded,
} from "./worker-runner-events";
import { createMcpProxyProvider, createWorkerDispatchRuntime } from "./worker-runner-ipc";
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

    const { traceId } = request;

    (async () => {
      const controller = new AbortController();
      let childAgentRuntime: ReturnType<typeof createChildAgentRuntime> | undefined;

      try {
        activeRuns.set(runId, { sessionId, controller });
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
          ipcAuthToken,
          runId,
          sessionId,
          ...(workspaceRoot ? { workspaceRoot } : {}),
        });

        const agentProvider = new AgentToolProvider({
          dispatchToolMode: "worker-resident-ask",
          dispatchRuntime: createWorkerDispatchRuntime({
            traceId,
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
        // #522 defect 2 scope: middleware is assembled ONCE by this host.
        // Children reference a subset of the parent assembly — the
        // injection-queue drain policy stays parent-only, because it drains
        // shared host state and persists drained responses into the parent
        // session's transcript.
        const middleware = [
          createContextMiddleware({ workspaceRoot: workspaceRoot ?? process.cwd() }),
          ...buildWorkerMiddleware({
            traceId,
            permissions: request.permissions,
            injectionQueue,
            ...(request.policyPlan ? { policyPlan: request.policyPlan } : {}),
          }),
        ];
        const childMiddleware = middleware.filter(
          (registration) => registration.name !== "builtin:injection-queue-drain",
        );
        childAgentRuntime = createChildAgentRuntime({
          model: request.model,
          systemPrompt: request.systemPrompt,
          parentMessages: messages,
          parentTools: () => childParentTools,
          injectionQueue,
          ...(workspaceRoot ? { workspaceRoot } : {}),
          traceContext: { traceId, sessionId, runId },
          parentSignal: controller.signal,
          auth: resolveAuth(request.model.provider),
          allowAuthFallback: false,
          ...(request.budget ? { budget: request.budget } : {}),
          ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
          middleware: childMiddleware,
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
        const runResult = await agent.run(
          {
            messages,
            traceContext: { traceId, sessionId, runId },
          },
          {
            onMessage: () => undefined,
            onToolCall: () => undefined,
            onToolResult: () => undefined,
            // #547 C3: the wiring point for WORKER sessions where the
            // transcript fact stream meets durable recording —
            // TranscriptStore.record commits the fact and its message/part
            // projection in one storage transaction (recording tier;
            // packages/session/src/session/transcript.ts). Injected
            // responses into this session record synthesized facts at the
            // injection-queue persistResponse seam (#562). Resident direct
            // runs stay sinkless on purpose and child-agent streams record
            // nothing (bounded) — see defaultRunAgent in
            // packages/openomni/src/resident/runtime.ts and the
            // writer census in Session.resume.
            onFact: (fact) => TranscriptStore.record(sessionId, fact),
          },
        );
        if (controller.signal.aborted) {
          publishWorkerRunCancelled({ traceId, sessionId, runId });

          respond({
            runId,
            sessionId,
            status: "cancelled",
            error: "cancelled by coordinator",
          });
          return;
        }

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
          publishWorkerRunCancelled({ traceId, sessionId, runId });

          respond({
            runId,
            sessionId,
            status: "cancelled",
            error: errorMessage,
          });
          return;
        }
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
