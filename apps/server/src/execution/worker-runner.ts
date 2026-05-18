import { ChatAgent } from "@openomni/agent";
import type { Auth } from "@openomni/llm";
import {
  AgentToolProvider,
  type BackgroundManager,
  SystemToolProvider,
  ToolProxyProvider,
  buildToolCatalog,
  buildWorkerMiddleware,
  createToolExecutor,
  createWorkerSubagentRuntime,
} from "@openomni/openomni";
import { Execution, Subagent, Tool, type WorkerBootstrap } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createContextMiddleware } from "../context/index";
import { WorkerInternalTools } from "./worker-internal-tools";
import type { WorkerRunState } from "./worker-run-state";
import { buildWorkerInputMessages, createExecutionToolContext } from "./worker-runtime";

const WORKER_TOOL_CALL_IPC_TIMEOUT_MS = 5 * 60_000;

export interface WorkerRunIpcServer {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
}

export namespace WorkerRunner {
  type ChatAgentOptions = Parameters<typeof ChatAgent.create>[0];
  type WorkerAgent = Pick<ReturnType<typeof ChatAgent.create>, "run">;

  export interface Environment {
    readonly ipcAuthToken: string;
    readonly workerId: string;
    readonly server: WorkerRunIpcServer;
    readonly activeRuns: WorkerRunState.ActiveRunRegistry;
    readonly bootstrapReady: Promise<void>;
    readonly backgroundManager: ReturnType<typeof BackgroundManager.create>;
    readonly defaultWorkspaceRoot: string | undefined;
    readonly getBootstrap: () => WorkerBootstrap.Bootstrap | null;
    readonly resolveAuth: (provider: string) => Auth.Info | undefined;
    readonly createAgent?: (options: ChatAgentOptions) => WorkerAgent;
  }

  export interface SpawnRunOptions extends Environment {
    readonly params: Record<string, unknown> | undefined;
    readonly respond: (result: unknown) => void;
  }

  export function spawnRun(options: SpawnRunOptions): void {
    const {
      params,
      ipcAuthToken,
      workerId,
      server,
      activeRuns,
      bootstrapReady,
      backgroundManager,
      defaultWorkspaceRoot,
      getBootstrap,
      resolveAuth,
      respond,
      createAgent = ChatAgent.create,
    } = options;

    if (params?.authToken !== ipcAuthToken) {
      respond({
        runId: typeof params?.runId === "string" ? params.runId : "unknown",
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
        status: "failed",
        error: "unauthorized coordinator request",
      });
      return;
    }

    let request: Execution.Request;
    try {
      request = Execution.Request.parse(params);
    } catch (err) {
      respond({
        runId: typeof params?.runId === "string" ? params.runId : "unknown",
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
        status: "failed",
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

      try {
        activeRuns.set(runId, { sessionId, controller, inbox: [] });
        server.notify("worker.run_started", { runId, sessionId });
        Bus.publish(Subagent.Events.WorkerRunStarted, {
          traceId,
          sessionId,
          runId,
          time: Date.now(),
          payload: { sessionId, runId, title: request.prompt.slice(0, 80) },
        });
        await bootstrapReady;
        const bootstrap = getBootstrap();
        const messages = buildWorkerInputMessages(sessionId, request.prompt);
        const workspaceRoot =
          request.workspaceRoot ?? request.toolConfig?.workspaceRoot ?? defaultWorkspaceRoot;
        const systemProvider = new SystemToolProvider(workspaceRoot);

        const mcpProxyProvider = ToolProxyProvider.create(
          bootstrap?.toolCatalog ?? [],
          async (toolName, toolArgs, context) => {
            const callId = crypto.randomUUID();
            if (context?.signal?.aborted) {
              return {
                id: callId,
                toolCallId: callId,
                output: "Tool call aborted",
                isError: true,
              };
            }

            const cancelToolCall = () => {
              void server
                .call("worker.tool_call_cancel", { runId, sessionId, callId }, 5_000)
                .catch(() => undefined);
            };
            context?.signal?.addEventListener("abort", cancelToolCall, { once: true });

            try {
              const raw = await server.call(
                "worker.tool_call",
                {
                  runId,
                  sessionId,
                  callId,
                  tool: toolName,
                  input: toolArgs,
                  ...(workspaceRoot ? { workspaceRoot } : {}),
                },
                WORKER_TOOL_CALL_IPC_TIMEOUT_MS,
              );
              return Tool.Result.parse(raw);
            } catch (error) {
              return {
                id: callId,
                toolCallId: callId,
                output: error instanceof Error ? error.message : String(error),
                isError: true,
                settlement: "unknown",
              };
            } finally {
              context?.signal?.removeEventListener("abort", cancelToolCall);
            }
          },
        );

        const toolsRef: Parameters<typeof createWorkerSubagentRuntime>[0]["toolsRef"] = {};
        const catalogRef: { catalog?: ReturnType<typeof buildToolCatalog> } = {};
        const agentDefinitionsRef: {
          definitions?: Map<string, WorkerBootstrap.RuntimeAgentDefinition>;
        } = {
          definitions: new Map((bootstrap?.agents ?? []).map((agent) => [agent.name, agent])),
        };

        const agentProvider = new AgentToolProvider({
          subagentRuntime: createWorkerSubagentRuntime({
            toolsRef,
            catalogRef,
            agentDefinitionsRef,
            resolveAuth,
            allowAuthFallback: false,
            parentSessionId: sessionId,
            parentPermissions: request.permissions,
          }),
          delegationContext: {
            depth: 0,
            maxDepth: 3,
            visitedAgents: new Set([request.agentName ?? "dev"]),
            parentAbort: controller.signal,
          },
          backgroundManager,
        });

        const systemTools = systemProvider.listTools();
        const agentTools = agentProvider.listTools();
        const proxyTools = mcpProxyProvider.listTools();
        const availableTools = [...systemTools, ...agentTools, ...proxyTools];
        const internalTools = WorkerInternalTools.create({
          runId,
          sessionId,
          server,
          ipcAuthToken,
          workerId,
          activeRuns,
        });
        const { tools, toolExecutor } = createExecutionToolContext(request, availableTools);
        const internalToolExecutor = createToolExecutor({
          tools: internalTools,
          config: {
            workspaceRoot,
            runtime: {
              sessionId,
              runId,
              agentName: request.agentName,
              workspaceRoot,
            },
          },
        });
        const internalToolNames = new Set(
          internalTools.flatMap((tool) => [tool.spec.name, tool.spec.name.replace(/\./g, "_")]),
        );
        const combinedToolExecutor = async (
          call: Tool.Call,
          context?: Tool.ExecutionContext,
        ): Promise<Tool.Result> => {
          if (internalToolNames.has(call.tool)) return internalToolExecutor(call, context);
          if (toolExecutor) return toolExecutor(call, context);
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Unknown worker tool: ${call.tool}`,
            isError: true,
          };
        };
        const exposedTools = [
          ...(tools ?? []),
          ...internalTools.map((tool) => ({
            ...tool.spec,
            name: tool.spec.name.replace(/\./g, "_"),
          })),
        ];

        toolsRef.tools = exposedTools;
        toolsRef.toolExecutor = combinedToolExecutor;
        catalogRef.catalog = buildToolCatalog([
          { tools: systemTools, source: "system" },
          { tools: agentTools, source: "agent" },
          { tools: proxyTools, source: "mcp" },
        ]);

        const agent = createAgent({
          model: request.model,
          auth: resolveAuth(request.model.provider),
          allowAuthFallback: false,
          signal: controller.signal,
          budget: request.budget,
          systemPrompt: [
            request.systemPrompt,
            "Worker runtime tools: use ask_main when you need Resident guidance or approval; use check_inbox to read live messages delivered while this run is active.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          tools: exposedTools,
          toolExecutor: combinedToolExecutor,
          middleware: [
            createContextMiddleware({ workspaceRoot: workspaceRoot ?? process.cwd() }),
            ...buildWorkerMiddleware({
              permissions: request.permissions,
              ...(request.policyPlan ? { policyPlan: request.policyPlan } : {}),
            }),
          ],
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
          Bus.publish(Subagent.Events.WorkerSessionCancelled, {
            traceId,
            sessionId,
            runId,
            time: Date.now(),
            payload: { sessionId, runId },
          });

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
        Bus.publish(Subagent.Events.WorkerRunCompleted, {
          traceId,
          sessionId,
          runId,
          time: Date.now(),
          payload: { sessionId, runId, status: "succeeded" },
        });

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
          Bus.publish(Subagent.Events.WorkerSessionCancelled, {
            traceId,
            sessionId,
            runId,
            time: Date.now(),
            payload: { sessionId, runId },
          });

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
        Bus.publish(Subagent.Events.WorkerRunFailed, {
          traceId,
          sessionId,
          runId,
          time: Date.now(),
          payload: { sessionId, runId, error: errorMessage },
        });

        respond({
          runId,
          sessionId,
          status: "failed",
          error: errorMessage,
        });
      } finally {
        activeRuns.delete(runId);
      }
    })();
  }
}

function notifyWorkerRunCompleted(
  server: WorkerRunIpcServer,
  params: Record<string, unknown>,
): void {
  try {
    server.notify("worker.run_completed", params);
  } catch {
    // Preserve coordinator response and active-run cleanup if notification fails.
  }
}
