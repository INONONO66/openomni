import { ChatAgent } from "@openomni/agent";
import type { BoundarySanitizer } from "@openomni/llm/credential-runtime";
import {
  SystemToolProvider,
  buildToolCatalog,
  buildWorkerMiddleware,
  createChildAgentRuntime,
  createChildAgentTool,
  resolveToolSelection,
} from "@openomni/openomni";
import type { BoundWorkerKernelPortV1, DispatchToolRuntime, NativeTool } from "@openomni/openomni";
import { Dispatch, Execution, Ipc } from "@openomni/protocol";
import { createMcpProxyProvider } from "./worker-runner-ipc";
import { respondSpawnRejected, type WorkerRunnerSpawnOptions } from "./worker-runner-types";
import {
  publishAttemptProcessObservation,
  type AttemptProcessObservation,
} from "./worker-runner-events";
import { buildWorkerInputMessages, createExecutionToolContext } from "./worker-runtime";
import type {
  P2CredentialProvisioningFrame,
  P2WorkerCredentialProvisioner,
} from "./p2-worker-provisioning";

function relayAttemptObservation(
  options: WorkerRunnerSpawnOptions,
  sessionId: string,
  runId: string,
  name: AttemptProcessObservation["name"],
  terminal?: { readonly reason?: string; readonly resultRef?: string },
): void {
  const { workItemId, attemptId, attemptSeq } = options.runtime.attempt;
  const data = {
    runId,
    sessionId,
    workItemId,
    attemptId,
    attemptSeq,
    workerId: options.workerId,
    generation: options.runtime.generation,
    time: Date.now(),
  };
  const observation: AttemptProcessObservation =
    name === "attempt.succeeded"
      ? { name, data: { ...data, resultRef: terminal?.resultRef ?? data.runId } }
      : name === "attempt.started"
        ? { name, data }
        : {
            name,
            data: {
              ...data,
              reason: sanitizeRunFailure(
                options.environment.sanitizer,
                "worker-attempt-observation",
                terminal?.reason ?? name,
              ),
            },
          };
  publishAttemptProcessObservation({
    server: options.server,
    authToken: options.ipcAuthToken,
    observation,
  });
}

function sanitizeObservationReason(reason: string): string {
  let sanitized = "";
  let replacingControlCharacters = false;
  for (const character of reason) {
    const characterCode = character.charCodeAt(0);
    if (characterCode <= 31 || characterCode === 127) {
      if (!replacingControlCharacters) sanitized += " ";
      replacingControlCharacters = true;
      continue;
    }
    sanitized += character;
    replacingControlCharacters = false;
  }
  return sanitized.trim().slice(0, 512) || "unspecified";
}

function sanitizeRunFailure(
  sanitizer: BoundarySanitizer,
  boundary: string,
  error: unknown,
): string {
  return sanitizeObservationReason(sanitizer.sanitizeError(boundary, error).message);
}

function sameProvisionedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createAuthenticatedQueryPort(
  options: WorkerRunnerSpawnOptions,
  sessionId: string,
  runId: string,
): {
  query(request: Parameters<BoundWorkerKernelPortV1["query"]>[0]): Promise<unknown>;
} {
  return Object.freeze({
    async query(request) {
      return options.server.call("worker.kernel_query", {
        authToken: options.ipcAuthToken,
        workerId: options.workerId,
        generation: options.runtime.generation,
        sessionId,
        runId,
        request,
      });
    },
  });
}

function createResidentAskRuntime(
  options: WorkerRunnerSpawnOptions,
  sessionId: string,
  runId: string,
): DispatchToolRuntime {
  return Object.freeze({
    async submit(input, context = {}) {
      const request = Dispatch.Input.parse(input);
      if (request.action !== Dispatch.Actions.ResidentAsk || request.target.kind !== "resident") {
        throw new Error("worker dispatch only supports resident.ask");
      }
      if (request.wait !== true) {
        throw new Error("worker dispatch resident.ask requires wait: true");
      }
      if (context.signal?.aborted) throw new Error("worker dispatch resident.ask aborted");
      const dispatchId = crypto.randomUUID();
      const raw = await options.server.call("worker.inbound_wait", {
        authToken: options.ipcAuthToken,
        workerId: options.workerId,
        generation: options.runtime.generation,
        sessionId,
        runId,
        callId: dispatchId,
        payload:
          typeof request.payload === "string" ? request.payload : JSON.stringify(request.payload),
      });
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("accepted" in raw) ||
        raw.accepted !== true
      ) {
        throw new Error("worker.inbound_wait rejected");
      }
      return Dispatch.Result.parse({
        dispatchId,
        status: "completed",
        output: "output" in raw && typeof raw.output === "string" ? raw.output : "",
      });
    },
  });
}

export namespace WorkerRunner {
  export async function acknowledgeCredentialProvisioning(options: {
    readonly provisioner: P2WorkerCredentialProvisioner;
    readonly frame: P2CredentialProvisioningFrame;
    readonly receipt: Ipc.CredentialProvisioningReceiptV1;
    readonly scrubbedBuffers: readonly Uint8Array[];
    readonly server: Pick<WorkerRunnerSpawnOptions["server"], "call">;
    readonly workerId: string;
    readonly generation: number;
    readonly processId: number;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<void> {
    const accepted = options.provisioner.provision(options.frame);
    if (!sameProvisionedValue(accepted, options.receipt)) {
      throw new Error("credential provisioning denied");
    }
    if (options.scrubbedBuffers.some((buffer) => buffer.some((byte) => byte !== 0))) {
      throw new Error("credential provisioning denied");
    }

    const acknowledgement = Ipc.Methods["worker.credential_provision_ack"].params.parse({
      workerId: options.workerId,
      generation: options.generation,
      processId: options.processId,
      runId: options.runId,
      sessionId: options.sessionId,
      receipt: options.receipt,
    });
    Ipc.Methods["worker.credential_provision_ack"].result.parse(
      await options.server.call("worker.credential_provision_ack", acknowledgement),
    );
  }
  export function spawnRun(options: WorkerRunnerSpawnOptions): void {
    const {
      params,
      ipcAuthToken,
      activeRuns,
      injectionQueue,
      runtime,
      workspaceIdentity,
      environment,
      modelCatalog,
      createAgentToolProvider,
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
    } catch (error) {
      respondSpawnRejected({
        params,
        respond,
        error: sanitizeRunFailure(environment.sanitizer, "worker-run-request", error),
      });
      return;
    }

    const { runId, sessionId } = request;
    const requestedToolConfig = params?.toolConfig;
    const hasStringWorkspace =
      params?.workspaceRoot !== undefined ||
      (requestedToolConfig !== null &&
        typeof requestedToolConfig === "object" &&
        "workspaceRoot" in requestedToolConfig);
    if (hasStringWorkspace) {
      respondSpawnRejected({
        params,
        respond,
        error: "string workspace roots are forbidden; use the provisioned WorkspaceIdentity",
      });
      return;
    }
    if (runtime.workerId !== options.workerId) {
      respondSpawnRejected({
        params,
        respond,
        error: "worker identity does not match provisioned runtime",
      });
      return;
    }
    if (
      request.model.provider !== runtime.config.model.provider ||
      request.model.id !== runtime.config.model.id
    ) {
      respondSpawnRejected({
        params,
        respond,
        error: "run model does not match provisioned runtime",
      });
      return;
    }
    if (environment.reference.environmentDigest !== runtime.config.environment.environmentDigest) {
      respondSpawnRejected({
        params,
        respond,
        error: "LLM environment does not match provisioned runtime",
      });
      return;
    }
    const agent = runtime.config.agents.length === 1 ? runtime.config.agents[0] : undefined;
    const catalogNames = runtime.config.toolCatalog.map((entry) => entry.spec.name);
    const exactCatalog =
      catalogNames.length === new Set(catalogNames).size &&
      (agent?.tools.allow ?? []).every((name) => catalogNames.includes(name));
    if (
      agent === undefined ||
      !exactCatalog ||
      request.agentName !== agent.name ||
      request.systemPrompt !== agent.systemPrompt ||
      request.model.provider !== agent.model.provider ||
      request.model.id !== agent.model.id ||
      !sameProvisionedValue(request.permissions, agent.permissions) ||
      !sameProvisionedValue(request.policyPlan, agent.policyPlan) ||
      !sameProvisionedValue(request.budget, agent.budget)
    ) {
      respondSpawnRejected({
        params,
        respond,
        error: "run agent does not match the authenticated runtime",
      });
      return;
    }
    if (activeRuns.has(runId)) {
      respond({
        runId,
        sessionId,
        status: "failed",
        error: sanitizeRunFailure(
          environment.sanitizer,
          "worker-run-active",
          `run already active: ${runId}`,
        ),
      });
      return;
    }

    void (async () => {
      const traceId = request.traceId ?? crypto.randomUUID();
      const controller = new AbortController();
      let childAgentRuntime: ReturnType<typeof createChildAgentRuntime> | undefined;

      try {
        const kernel = createAuthenticatedQueryPort(options, sessionId, runId);
        const attemptResult = Execution.KernelQueryResultV1.parse(
          await kernel.query({
            version: "kernel-query-v1",
            kind: "authenticated_attempt",
            attempt: runtime.attempt,
          }),
        );
        if (
          attemptResult.kind !== "authenticated_attempt" ||
          !sameProvisionedValue(attemptResult.attempt, runtime.attempt)
        ) {
          throw new Error("run attempt does not match the authenticated runtime");
        }
        activeRuns.set(runId, { sessionId, controller });
        relayAttemptObservation(options, sessionId, runId, "attempt.started");

        if (
          runtime.config.workspace.workspaceId !== workspaceIdentity.workspaceId ||
          runtime.config.workspace.canonicalBytesDigest !== workspaceIdentity.canonicalBytesDigest
        ) {
          throw new Error("worker workspace identity does not match the provisioned runtime");
        }

        const messages = await buildWorkerInputMessages(kernel, sessionId, request.prompt);
        const authenticatedToolNames = new Set(
          runtime.config.toolCatalog.map((entry) => entry.spec.name),
        );
        const systemProvider = new SystemToolProvider(workspaceIdentity);
        const systemTools = systemProvider
          .listTools()
          .filter((tool) => authenticatedToolNames.has(tool.spec.name));
        const nativeNames = new Set(systemTools.map((tool) => tool.spec.name));
        nativeNames.add("dispatch");
        nativeNames.add("child_agent");
        const mcpProxyProvider = createMcpProxyProvider({
          sanitizer: environment.sanitizer,
          toolCatalog: runtime.config.toolCatalog
            .map((entry) => entry.spec)
            .filter((spec) => !nativeNames.has(spec.name)),
          server: options.server,
          ipcAuthToken,
          workerId: options.workerId,
          generation: runtime.generation,
          runId,
          sessionId,
        });
        const proxyTools = mcpProxyProvider.listTools();
        const agentProvider = createAgentToolProvider({
          workspaceIdentity,
          dispatchToolMode: "worker-resident-ask",
          dispatchRuntime: createResidentAskRuntime(options, sessionId, runId),
        });
        const availableTools: NativeTool[] = [...systemTools, ...proxyTools];
        let childParentTools: readonly NativeTool[] = [];
        const middleware = buildWorkerMiddleware({
          permissions: agent.permissions,
          injectionQueue,
          ...(agent.policyPlan ? { policyPlan: agent.policyPlan } : {}),
        });
        if (authenticatedToolNames.has("child_agent")) {
          childAgentRuntime = createChildAgentRuntime({
            model: agent.model,
            systemPrompt: agent.systemPrompt,
            parentMessages: messages,
            parentTools: () => childParentTools,
            injectionQueue,
            traceContext: { traceId, sessionId, runId },
            parentSignal: controller.signal,
            environment,
            modelCatalog,
            ...(agent.budget ? { budget: agent.budget } : {}),
            ...(runtime.config.providerOptions
              ? { providerOptions: runtime.config.providerOptions }
              : {}),
            middleware,
            createAgent,
          });
          agentProvider.register(createChildAgentTool(childAgentRuntime));
        }
        const agentTools = agentProvider
          .listTools()
          .filter((tool) => authenticatedToolNames.has(tool.spec.name));
        availableTools.push(...agentTools);
        const selectedTools = resolveToolSelection(
          buildToolCatalog([
            { tools: systemTools, source: "system" },
            { tools: proxyTools, source: "mcp" },
            { tools: agentTools, source: "agent" },
          ]),
          agent.tools,
        ).map((entry) => entry.tool);
        childParentTools = selectedTools.filter((tool) => tool.spec.name !== "child_agent");
        const executionRequest = {
          ...request,
          tools: selectedTools.map((tool) => tool.spec),
          permissions: agent.permissions,
          agentName: agent.name,
        };
        const { tools, toolExecutor } = createExecutionToolContext(executionRequest, selectedTools);

        const chatAgent = createAgent({
          model: agent.model,
          environment,
          modelCatalog,
          signal: controller.signal,
          budget: agent.budget,
          systemPrompt: agent.systemPrompt,
          tools: tools ?? [],
          toolExecutor,
          ...(runtime.config.providerOptions
            ? { providerOptions: runtime.config.providerOptions }
            : {}),
          middleware,
        });
        const runResult = await chatAgent.run({
          messages,
          traceContext: { traceId, sessionId, runId },
        });
        if (controller.signal.aborted) {
          relayAttemptObservation(options, sessionId, runId, "attempt.cancelled", {
            reason: "cancelled by coordinator",
          });
          respond({
            runId,
            sessionId,
            status: "cancelled",
            error: "cancelled by coordinator",
          });
          return;
        }

        relayAttemptObservation(options, sessionId, runId, "attempt.succeeded", {
          resultRef: runId,
        });
        respond({
          runId,
          sessionId,
          status: "succeeded",
          output: runResult.text,
          finishReason: runResult.finishReason,
        });
      } catch (error) {
        const errorMessage = sanitizeRunFailure(environment.sanitizer, "worker-run", error);
        const wasCancelled = controller.signal.aborted;
        relayAttemptObservation(
          options,
          sessionId,
          runId,
          wasCancelled ? "attempt.cancelled" : "attempt.failed",
          {
            reason: errorMessage,
          },
        );
        respond({
          runId,
          sessionId,
          status: wasCancelled ? "cancelled" : "failed",
          error: errorMessage,
        });
      } finally {
        childAgentRuntime?.cancelAll();
        injectionQueue.dispose(runId);
        activeRuns.delete(runId);
        options.onSettled?.();
      }
    })();
  }
}
