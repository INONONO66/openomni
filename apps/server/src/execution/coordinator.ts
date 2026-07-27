import { Execution, WorkerDeliveryError, type BusEvent, type Tool } from "@openomni/protocol";
import {
  createWorkerManager,
  type InboundWaitParams,
  type InboundWaitResult,
  type ToolCallContext,
  type WorkerCredentialProvisioningPort,
  type WorkerKernelQueryPort,
  type WorkerKernelTransitionPort,
  type WorkerManager,
  type WorkerObservationPort,
} from "@openomni/coordinator";
import {
  type AgentToolProvider,
  bindAuthenticatedWorkerKernelPort,
  type AuthenticatedWorkerIdentityV1,
  type KernelQueryPortV1,
  type KernelTransitionPortV1,
  type ToolExecutionContext,
  type ToolProvider,
} from "@openomni/openomni";
import type { P2ProductionRuntime } from "../bootstrap/p2-runtime";
import type { RecoveryResult } from "./recovery";

export type ToolDispatchHandler = (
  call: Tool.Call,
  context?: ToolExecutionContext,
) => Promise<Tool.Result>;

type WorkerKernelTargetBinding = Parameters<typeof bindAuthenticatedWorkerKernelPort>[1];
type WithoutIdentity<T> = T extends { readonly identity: AuthenticatedWorkerIdentityV1 }
  ? Omit<T, "identity">
  : never;

type WorkerRuntimeDefinitionPort = Parameters<typeof createWorkerManager>[1]["runtimeDefinition"];

export interface AuthenticatedWorkerKernelChannel {
  readonly identity: AuthenticatedWorkerIdentityV1;
  readonly target: WorkerKernelTargetBinding;
}

export interface AuthenticatedWorkerKernelHandlers {
  transition(
    params: Record<string, unknown> | undefined,
    channel: AuthenticatedWorkerKernelChannel,
  ): Promise<unknown>;
  query(
    params: Record<string, unknown> | undefined,
    channel: AuthenticatedWorkerKernelChannel,
  ): Promise<unknown>;
}

export function createAuthenticatedWorkerKernelHandlers(options: {
  readonly transitions: KernelTransitionPortV1;
  readonly queries: KernelQueryPortV1;
}): AuthenticatedWorkerKernelHandlers {
  const bind = (
    params: Record<string, unknown> | undefined,
    channel: AuthenticatedWorkerKernelChannel,
  ) => {
    assertWorkerChannelClaims(params, channel.identity);
    return bindAuthenticatedWorkerKernelPort(
      channel.identity,
      channel.target,
      options.transitions,
      options.queries,
    );
  };
  const handlers: AuthenticatedWorkerKernelHandlers = {
    transition(
      params: Record<string, unknown> | undefined,
      channel: AuthenticatedWorkerKernelChannel,
    ) {
      const command = params?.command;
      if (command === null || typeof command !== "object" || Array.isArray(command)) {
        return Promise.reject(new TypeError("invalid worker.kernel_transition params"));
      }
      return bind(params, channel).execute(
        command as WithoutIdentity<Execution.KernelTransitionCommandV1>,
      );
    },
    query(params: Record<string, unknown> | undefined, channel: AuthenticatedWorkerKernelChannel) {
      const request = params?.request;
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        return Promise.reject(new TypeError("invalid worker.kernel_query params"));
      }
      return bind(params, channel).query(request as WithoutIdentity<Execution.KernelQueryV1>);
    },
  };
  return Object.freeze(handlers);
}

function assertWorkerChannelClaims(
  params: Record<string, unknown> | undefined,
  identity: AuthenticatedWorkerIdentityV1,
): void {
  if (
    params?.workerId !== identity.workerId ||
    params?.sessionId !== identity.sessionId ||
    params?.runId !== identity.runId
  ) {
    throw new Error("authenticated worker channel binding mismatch");
  }
}

export type CoordinatorConfig = {
  readonly workerScript: string;
  readonly runtimeId: string;
  readonly principalId: string;
  readonly workerCount?: number;
  readonly maxWorkers?: number;
  readonly workerIdleTimeoutMs?: number;
  readonly socketDir?: string;
  readonly bootstrap: Readonly<Record<string, unknown>> & {
    readonly configEpoch: string;
    readonly credentials?: never;
  };
  readonly runtime: P2ProductionRuntime<{
    recoverInterruptedRuns(): Promise<RecoveryResult>;
  }>;
  readonly events: BusEvent.Sink;
  readonly kernelTransition: WorkerKernelTransitionPort;
  readonly kernelQuery: WorkerKernelQueryPort;
  readonly observation: WorkerObservationPort;
  readonly provisionCredentials: WorkerCredentialProvisioningPort;
  readonly runtimeDefinition: WorkerRuntimeDefinitionPort;
  readonly getAgentToolProvider: () => AgentToolProvider;
  readonly toolProviders: readonly ToolProvider[];
  readonly askResident: (params: InboundWaitParams) => Promise<InboundWaitResult>;
};

export function buildToolDispatcher(providers: ToolProvider[]): Map<string, ToolDispatchHandler> {
  const dispatcher = new Map<string, ToolDispatchHandler>();

  for (const provider of providers) {
    for (const tool of provider.listTools()) {
      const canonicalName = tool.spec.name;
      if (dispatcher.has(canonicalName)) {
        throw new Error(`Duplicate tool in dispatcher: "${canonicalName}"`);
      }
      dispatcher.set(canonicalName, (call, context) => provider.execute(call, context));
    }
  }

  return dispatcher;
}

export type ExecutionCoordinator = {
  dispatch(sessionTreeId: string, request: Execution.Request): Promise<Execution.Result>;
  cancelRun(runId: string): Promise<unknown>;
  deliverMessage(sessionId: string, message: string, runId?: string): Promise<unknown>;
  getStats(): {
    workers: number;
    active: number;
    idle: number;
    ready: number;
    activeRuns: number;
    maxActiveWorkers: number;
  };
  waitUntilReady(timeoutMs?: number): Promise<void>;
  recoverInterruptedRuns(): Promise<RecoveryResult>;
  shutdown(): Promise<void>;
};

export function createExecutionCoordinator(config: CoordinatorConfig): ExecutionCoordinator {
  const toolDispatcher = buildToolDispatcher([...config.toolProviders]);

  const workerManager: WorkerManager = createWorkerManager(
    {
      workerScript: config.workerScript,
      runtimeId: config.runtimeId,
      principalId: config.principalId,
      maxActiveWorkers: config.maxWorkers ?? config.workerCount,
      idleShutdownMs: config.workerIdleTimeoutMs,
      socketDir: config.socketDir,
      bootstrap: config.bootstrap,
    },
    {
      events: config.events,
      inboundWait: config.askResident,
      kernelTransition: config.kernelTransition,
      kernelQuery: config.kernelQuery,
      observation: config.observation,
      provisionCredentials: config.provisionCredentials,
      runtimeDefinition: config.runtimeDefinition,
      toolRelay: async (params, context?: ToolCallContext) => {
        const call: Tool.Call = {
          id: params.callId,
          tool: params.tool,
          input: params.input,
        };
        let handler = toolDispatcher.get(params.tool);
        if (!handler) {
          const agentProvider = config.getAgentToolProvider();
          if (agentProvider.listTools().some((tool) => tool.spec.name === params.tool)) {
            handler = (agentCall, agentContext) => agentProvider.execute(agentCall, agentContext);
          }
        }
        if (!handler) {
          return {
            id: params.callId,
            toolCallId: params.callId,
            output: `Unknown tool: ${params.tool}`,
            isError: true,
          };
        }
        const result = await handler(call, context);
        return {
          id: result.id,
          toolCallId: result.toolCallId,
          output: result.output,
          isError: result.isError,
        };
      },
    },
  );

  let isDraining = false;

  return {
    async dispatch(sessionTreeId, request) {
      if (isDraining) {
        throw new Error("Execution coordinator is draining");
      }

      // Slot affinity keys on task.sessionId. Every production dispatch site
      // passes sessionTreeId === request.sessionId; a caller that diverges
      // would silently shift slot affinity, so the invariant is enforced here.
      if (sessionTreeId !== request.sessionId) {
        throw new WorkerDeliveryError({
          message: `dispatch sessionTreeId ${sessionTreeId} does not match request.sessionId ${request.sessionId}`,
          code: "session_mismatch",
          runId: request.runId,
          sessionId: request.sessionId,
        });
      }
      const raw = await workerManager.deliver(request.runId, { ...request });
      return Execution.Result.parse(raw);
    },

    async cancelRun(runId) {
      return workerManager.cancel(runId);
    },

    async deliverMessage(sessionId, message, runId) {
      return workerManager.send(sessionId, message, runId);
    },

    getStats() {
      return workerManager.stats();
    },

    async waitUntilReady(timeoutMs) {
      await workerManager.waitUntilReady(timeoutMs);
    },

    async recoverInterruptedRuns() {
      return config.runtime.services.recoverInterruptedRuns();
    },

    async shutdown() {
      isDraining = true;

      const deadline = Date.now() + 60_000;
      while (workerManager.stats().activeRuns > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }

      await workerManager.shutdown();
    },
  };
}
