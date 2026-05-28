import { ChatAgent } from "@openomni/agent";
import type { Auth } from "@openomni/llm";
import {
  AgentToolProvider,
  type BackgroundManager,
  type InjectionQueue,
  SystemToolProvider,
  ToolProxyProvider,
  buildToolCatalog,
  buildWorkerMiddleware,
  buildWorkerChildRuntimeConfig,
  createWorkerSubagentRuntime,
} from "@openomni/openomni";
import { Execution, type Ingress, Subagent, Tool, type WorkerBootstrap } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createContextMiddleware } from "../context/index";
import type { WorkerRunState } from "./worker-run-state";
import { buildWorkerInputMessages, createExecutionToolContext } from "./worker-runtime";

const WORKER_TOOL_CALL_IPC_TIMEOUT_MS = 5 * 60_000;
const WORKER_INBOUND_WAIT_IPC_TIMEOUT_MS = 5 * 60_000;

function buildDelegationAdmissionMiddleware(
  request: Execution.Request,
): ReturnType<typeof buildWorkerMiddleware> | undefined {
  if (!request.policyPlan) return undefined;
  return buildWorkerMiddleware({
    permissions: request.permissions,
    policyPlan: request.policyPlan,
    includeLifecycle: false,
    includeIdle: false,
  }).map((registration) => ({ ...registration, propagate: true }));
}

function createToolCallAbortError(): Error {
  const error = new Error("Tool call aborted");
  error.name = "AbortError";
  return error;
}

function abortableIpcCall<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(createToolCallAbortError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const handleAbort = () => {
      onAbort();
      finish(() => reject(createToolCallAbortError()));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function createWorkerInboundIngress(options: {
  readonly server: WorkerRunIpcServer;
  readonly ipcAuthToken: string;
  readonly workerId: string;
  readonly sessionId: string;
  readonly runId: string;
}): {
  ingest(
    event: Ingress.InboundEvent,
    context?: { readonly signal?: AbortSignal; readonly wait?: boolean },
  ): Promise<Ingress.IngressResult>;
} {
  return {
    async ingest(event, context) {
      if (!context?.wait) {
        throw new Error("worker inbound_message async delivery requires coordinator routing");
      }
      if (event.target?.kind !== "resident") {
        throw new Error("worker inbound_message wait currently supports resident targets only");
      }

      const callId = crypto.randomUUID();
      const payload =
        typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
      const cancelInboundWait = () => {
        void options.server
          .call(
            "worker.inbound_wait_cancel",
            { sessionId: options.sessionId, runId: options.runId, callId },
            5_000,
          )
          .catch(() => undefined);
      };

      const raw = await abortableIpcCall(
        () =>
          options.server.call(
            "worker.inbound_wait",
            {
              authToken: options.ipcAuthToken,
              workerId: options.workerId,
              sessionId: options.sessionId,
              runId: options.runId,
              callId,
              payload,
            },
            WORKER_INBOUND_WAIT_IPC_TIMEOUT_MS,
          ),
        context.signal,
        cancelInboundWait,
      );

      if (raw === null || typeof raw !== "object") {
        throw new Error("invalid worker.inbound_wait response");
      }
      const result = raw as { accepted?: unknown; output?: unknown; error?: unknown };
      if (result.accepted !== true) {
        throw new Error(
          typeof result.error === "string" ? result.error : "worker.inbound_wait rejected",
        );
      }

      return {
        mode: "direct",
        target: { kind: "resident" },
        sessionId: options.sessionId,
        result: {
          output: typeof result.output === "string" ? result.output : "",
          finishReason: "stop",
        },
      };
    },
  };
}

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
    readonly injectionQueue: InjectionQueue.Instance;
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
      server,
      activeRuns,
      bootstrapReady,
      backgroundManager,
      injectionQueue,
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
        activeRuns.set(runId, { sessionId, controller });
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

            try {
              const raw = await abortableIpcCall(
                () =>
                  server.call(
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
                  ),
                context?.signal,
                cancelToolCall,
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

        const workerSubagentConfig: Parameters<typeof createWorkerSubagentRuntime>[0] = {
          toolsRef,
          catalogRef,
          agentDefinitionsRef,
          resolveAuth,
          allowAuthFallback: false,
          parentSessionId: sessionId,
          parentPermissions: request.permissions,
        };
        const scopedBackgroundManager: ReturnType<typeof BackgroundManager.create> = {
          launch(input: Parameters<typeof backgroundManager.launch>[0]) {
            const childRuntime = buildWorkerChildRuntimeConfig(workerSubagentConfig, {
              agentName: input.agentName,
              depth: input.depth ?? 1,
              middleware: input.middleware,
            });
            return backgroundManager.launch({
              ...input,
              systemPrompt: childRuntime.systemPrompt,
              tools: childRuntime.tools,
              toolExecutor: childRuntime.toolExecutor,
              permissions: childRuntime.permissions,
              middleware: childRuntime.middleware,
              childMiddleware: childRuntime.childMiddleware,
            });
          },
          getTask: (taskId) => backgroundManager.getTask(taskId),
          getResult: (taskId) => backgroundManager.getResult(taskId),
          cancel: (taskId) => backgroundManager.cancel(taskId),
          listByParent: (parentSessionId) => backgroundManager.listByParent(parentSessionId),
          cleanup: () => backgroundManager.cleanup(),
          stats: () => backgroundManager.stats(),
          dispose: () => backgroundManager.dispose(),
        };

        const agentProvider = new AgentToolProvider({
          subagentRuntime: createWorkerSubagentRuntime(workerSubagentConfig),
          ingressEngine: createWorkerInboundIngress({
            server,
            ipcAuthToken,
            workerId: options.workerId,
            sessionId,
            runId,
          }),
          middleware: buildDelegationAdmissionMiddleware(request),
          delegationContext: {
            depth: 0,
            maxDepth: 3,
            visitedAgents: new Set([request.agentName ?? "dev"]),
            parentAbort: controller.signal,
          },
          backgroundManager: scopedBackgroundManager,
        });

        const systemTools = systemProvider.listTools();
        const agentTools = agentProvider.listTools();
        const proxyTools = mcpProxyProvider.listTools();
        const availableTools = [...systemTools, ...agentTools, ...proxyTools];
        const { tools, toolExecutor } = createExecutionToolContext(request, availableTools);
        const exposedTools = tools ?? [];

        toolsRef.tools = exposedTools;
        toolsRef.toolExecutor = toolExecutor;
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
            "Worker runtime tools: use inbound_message with wait: true to ask the Resident for guidance or approval; responses from other agents arrive automatically, no polling needed.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          tools: exposedTools,
          toolExecutor,
          ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
          middleware: [
            createContextMiddleware({ workspaceRoot: workspaceRoot ?? process.cwd() }),
            ...buildWorkerMiddleware({
              permissions: request.permissions,
              injectionQueue,
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
        injectionQueue.dispose(runId);
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
