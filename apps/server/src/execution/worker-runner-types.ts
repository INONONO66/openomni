import type { ChatAgent } from "@openomni/agent";
import type { Auth } from "@openomni/llm";
import type { InjectionQueue } from "@openomni/openomni";
import type { WorkerBootstrap } from "@openomni/protocol";
import type { WorkerRunIpcServer } from "./worker-runner-ipc";

// merged from worker-run-state.ts (fragment sweep)
export namespace WorkerRunState {
  interface ActiveRun {
    readonly sessionId: string;
    readonly controller: AbortController;
  }

  export type ActiveRunRegistry = Map<string, ActiveRun>;
  export type ReadableActiveRuns = Pick<ActiveRunRegistry, "get" | "entries" | "size">;
}

type WorkerRunnerChatAgentOptions = Parameters<typeof ChatAgent.create>[0];
type WorkerRunnerAgent = Pick<ReturnType<typeof ChatAgent.create>, "run">;

interface WorkerRunnerEnvironment {
  readonly ipcAuthToken: string;
  readonly workerId: string;
  readonly server: WorkerRunIpcServer;
  readonly activeRuns: WorkerRunState.ActiveRunRegistry;
  readonly bootstrapReady: Promise<void>;
  readonly injectionQueue: InjectionQueue.Instance;
  readonly defaultWorkspaceRoot: string | undefined;
  readonly getBootstrap: () => WorkerBootstrap.Bootstrap | null;
  readonly resolveAuth: (provider: string) => Auth.Info | undefined;
  readonly createAgent?: (options: WorkerRunnerChatAgentOptions) => WorkerRunnerAgent;
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
