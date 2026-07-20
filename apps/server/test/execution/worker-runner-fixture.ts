import type { AgentResult } from "@openomni/agent";
import { InjectionQueue } from "@openomni/openomni";

import type { WorkerRunState } from "../../src/execution/worker-run-state";
import type { WorkerRunner } from "../../src/execution/worker-runner";

export type ActiveRun = NonNullable<ReturnType<WorkerRunState.ActiveRunRegistry["get"]>>;
type SpawnRunOptions = Parameters<typeof WorkerRunner.spawnRun>[0];
type WorkerRunnerEnvironment = Omit<SpawnRunOptions, "params" | "respond">;

export const successfulResult: AgentResult = {
  text: "done",
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  finishReason: "stop",
};

export function createSpawnOptions(
  params: Record<string, unknown> | undefined,
  respond: (result: unknown) => void,
  overrides: Partial<WorkerRunnerEnvironment> = {},
): SpawnRunOptions {
  const activeRuns = overrides.activeRuns ?? new Map();
  return {
    params,
    ipcAuthToken: "token",
    workerId: "worker-1",
    server: {
      async call() {
        throw new Error("unexpected server call");
      },
      notify() {
        throw new Error("unexpected server notification");
      },
    },
    activeRuns,
    bootstrapReady: Promise.resolve(),
    injectionQueue: InjectionQueue.create(),
    defaultWorkspaceRoot: undefined,
    getBootstrap: () => null,
    resolveAuth: () => undefined,
    respond,
    ...overrides,
  };
}

export function createValidRequest(): Record<string, unknown> {
  return {
    authToken: "token",
    runId: "run-1",
    sessionId: "session-1",
    mode: "direct",
    prompt: "hello",
    model: { provider: "test", id: "test" },
  };
}
