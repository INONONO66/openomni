import type { ChatAgent, ChatAgentConfig } from "@openomni/agent";
import type {
  AgentToolProvider,
  DispatchToolRuntime,
  InjectionQueue,
  WorkspaceIdentity,
} from "@openomni/openomni";
import type { WorkerRuntimeDefinition } from "../agents/runtime-definition";
import type { WorkerRunState } from "./worker-run-state";
import type { WorkerRunIpcServer } from "./worker-runner-ipc";

type WorkerRunnerChatAgentOptions = Parameters<typeof ChatAgent.create>[0];
type WorkerRunnerAgent = Pick<ReturnType<typeof ChatAgent.create>, "run">;

interface WorkerRunnerEnvironment {
  readonly ipcAuthToken: string;
  readonly workerId: string;
  readonly server: WorkerRunIpcServer;
  readonly activeRuns: WorkerRunState.ActiveRunRegistry;
  readonly injectionQueue: InjectionQueue.Instance;
  readonly runtime: WorkerRuntimeDefinition;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly environment: ChatAgentConfig["environment"];
  readonly modelCatalog: ChatAgentConfig["modelCatalog"];
  readonly createAgentToolProvider: (options: {
    readonly workspaceIdentity: WorkspaceIdentity;
    readonly dispatchRuntime: DispatchToolRuntime;
    readonly dispatchToolMode: "worker-resident-ask";
  }) => AgentToolProvider;
  readonly createAgent?: (options: WorkerRunnerChatAgentOptions) => WorkerRunnerAgent;
  readonly onSettled?: () => void;
}

export interface WorkerRunnerSpawnOptions extends WorkerRunnerEnvironment {
  readonly params: Record<string, unknown> | undefined;
  readonly respond: (result: unknown) => void;
}

export function respondSpawnRejected(options: {
  readonly params: Record<string, unknown> | undefined;
  readonly respond: (result: unknown) => void;
  readonly error: string;
}): void {
  const { params, respond, error } = options;
  respond({
    runId: typeof params?.runId === "string" ? params.runId : "unknown",
    sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
    status: "failed",
    error,
  });
}
