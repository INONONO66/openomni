import type { AgentResult } from "@openomni/agent";
import type { TraceContext } from "@openomni/protocol";
import { InjectionQueue } from "@openomni/openomni";
import { Storage } from "@openomni/session";

import type { WorkerRunState } from "../../src/execution/worker-runner-types";
import type { WorkerRunner } from "../../src/execution/worker-runner";
import { newTraceId } from "@openomni/telemetry";

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
  // These suites call spawnRun in-process without the worker-entry bootstrap;
  // Storage.get() fails closed (#522), so guarantee an adapter here.
  if (Storage.getInitializedDbPath() === null) {
    Storage.initialize({ dbPath: ":memory:" });
  }
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

const TEST_RUN_TRACE_ID = newTraceId();

/**
 * The context the real agent wrapper attaches to every tool call
 * (`packages/agent/src/core/execution/tool-executor.ts`). A double that calls
 * `options.toolExecutor` directly has to supply it too, or it is standing in
 * for something production never does.
 */
export function toolCallContext(): { readonly traceContext: TraceContext.Type } {
  return {
    traceContext: { traceId: TEST_RUN_TRACE_ID, sessionId: "session-1", runId: "run-1" },
  };
}

export function createValidRequest(): Record<string, unknown> {
  return {
    authToken: "token",
    // A worker run inherits the dispatch trace; the runner refuses to mint one
    // (#606), so a request without it is a wiring defect, not a default.
    traceId: TEST_RUN_TRACE_ID,
    runId: "run-1",
    sessionId: "session-1",
    mode: "direct",
    prompt: "hello",
    model: { provider: "test", id: "test" },
  };
}
