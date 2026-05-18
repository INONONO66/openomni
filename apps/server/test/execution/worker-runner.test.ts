import { describe, expect, it } from "bun:test";
import type { AgentResult } from "@openomni/agent";
import { BackgroundManager, WorkspaceLock } from "@openomni/openomni";
import type { Tool, WorkerBootstrap } from "@openomni/protocol";

import type { WorkerRunState } from "../../src/execution/worker-run-state";
import { WorkerRunner } from "../../src/execution/worker-runner";

const successfulResult: AgentResult = {
  text: "done",
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  finishReason: "stop",
};

function createSpawnOptions(
  params: Record<string, unknown> | undefined,
  respond: (result: unknown) => void,
  overrides: Partial<WorkerRunner.Environment> = {},
): WorkerRunner.SpawnRunOptions {
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
    backgroundManager: BackgroundManager.create({
      maxConcurrentPerAgent: 1,
      maxConcurrentTotal: 1,
      maxDepth: 1,
      resolveAuth: () => undefined,
      allowAuthFallback: false,
    }),
    defaultWorkspaceRoot: undefined,
    getBootstrap: () => null,
    resolveAuth: () => undefined,
    respond,
    ...overrides,
  };
}

function createValidRequest(): Record<string, unknown> {
  return {
    authToken: "token",
    runId: "run-1",
    sessionId: "session-1",
    mode: "direct",
    prompt: "hello",
    model: { provider: "test", id: "test" },
  };
}

describe("WorkerRunner", () => {
  it("rejects unauthorized spawn requests without starting a run", () => {
    const responses: unknown[] = [];
    const options = createSpawnOptions(
      {
        authToken: "wrong",
        runId: "run-1",
        sessionId: "session-1",
      },
      (result) => responses.push(result),
    );

    WorkerRunner.spawnRun(options);

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "unauthorized coordinator request",
      },
    ]);
    expect(options.activeRuns.size).toBe(0);
  });

  it("rejects malformed spawn requests before starting a run", () => {
    const responses: unknown[] = [];
    const options = createSpawnOptions(
      {
        authToken: "token",
        runId: "run-1",
        sessionId: "session-1",
      },
      (result) => responses.push(result),
    );

    WorkerRunner.spawnRun(options);

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      status: "failed",
    });
    expect(options.activeRuns.size).toBe(0);
  });

  it("rejects duplicate run ids without replacing the active run", () => {
    const responses: unknown[] = [];
    const existingRun: WorkerRunState.ActiveRun = {
      sessionId: "session-1",
      controller: new AbortController(),
      inbox: ["existing"],
    };
    const activeRuns = new Map([["run-1", existingRun]]);
    const options = createSpawnOptions(createValidRequest(), (result) => responses.push(result), {
      activeRuns,
    });

    WorkerRunner.spawnRun(options);

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "run already active: run-1",
      },
    ]);
    expect(activeRuns.get("run-1")).toBe(existingRun);
  });

  it("reports failed runs and cleans state when start notification fails", async () => {
    const responses: unknown[] = [];
    const activeRuns = new Map();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          activeRuns,
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              throw new Error("notify failed");
            },
          },
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "notify failed",
      },
    ]);
    expect(activeRuns.size).toBe(0);
  });

  it("runs valid spawn requests and cleans active run state after success", async () => {
    const responses: unknown[] = [];
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const activeRuns = new Map();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          activeRuns,
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify(method, params) {
              notifications.push({ method, params });
            },
          },
          createAgent: () => ({
            async run(input) {
              expect(activeRuns.get("run-1")?.sessionId).toBe("session-1");
              expect(input.traceContext).toEqual({
                traceId: expect.any(String),
                sessionId: "session-1",
                runId: "run-1",
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "succeeded",
        output: "done",
        finishReason: "stop",
      },
    ]);
    expect(notifications).toEqual([
      { method: "worker.run_started", params: { runId: "run-1", sessionId: "session-1" } },
      {
        method: "worker.run_completed",
        params: { runId: "run-1", sessionId: "session-1", status: "succeeded", output: "done" },
      },
    ]);
    expect(activeRuns.size).toBe(0);
  });

  it("returns unknown settlement for proxied tool IPC failures and uses an extended call timeout", async () => {
    const responses: unknown[] = [];
    const workspaceRoot = `/tmp/openomni-worker-runner-test-${crypto.randomUUID()}`;
    const serverCalls: Array<{
      method: string;
      params?: Record<string, unknown>;
      timeoutMs?: number;
    }> = [];
    let proxiedResult: Tool.Result | undefined;
    const bootstrap: WorkerBootstrap.Bootstrap = {
      configEpoch: "epoch-1",
      agents: [],
      toolCatalog: [
        {
          canonicalName: "mcp.server.write_file",
          exposedName: "mcp_server_write_file",
          source: "mcp",
          category: "execution",
          riskTier: 1,
          spec: { name: "mcp.server.write_file", inputSchema: {} },
        },
      ],
    };
    const request = createValidRequest();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...request,
          tools: [{ name: "mcp.server.write_file", inputSchema: {} }],
          toolConfig: { workspaceRoot },
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call(method, params, timeoutMs) {
              serverCalls.push({ method, params, timeoutMs });
              throw new Error("request timeout: worker.tool_call");
            },
            notify() {
              // lifecycle notification
            },
          },
          getBootstrap: () => bootstrap,
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              proxiedResult = await options.toolExecutor({
                id: "agent-tool-call",
                tool: "mcp_server_write_file",
                input: {},
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    try {
      await responseReceived;

      expect(proxiedResult).toMatchObject({
        id: expect.any(String),
        toolCallId: expect.any(String),
        output: "request timeout: worker.tool_call",
        isError: true,
        settlement: "unknown",
      });
      expect(serverCalls).toContainEqual(
        expect.objectContaining({
          method: "worker.tool_call",
          timeoutMs: 300_000,
        }),
      );
      expect(responses[0]).toMatchObject({ status: "succeeded" });
    } finally {
      WorkspaceLock.clearUnsafe(workspaceRoot);
    }
  });

  it("reports failed runs and cleans active run state after agent errors", async () => {
    const responses: unknown[] = [];
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const activeRuns = new Map();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          activeRuns,
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify(method, params) {
              notifications.push({ method, params });
            },
          },
          createAgent: () => ({
            async run() {
              throw new Error("agent failed");
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses).toEqual([
      {
        runId: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "agent failed",
      },
    ]);
    expect(notifications).toEqual([
      { method: "worker.run_started", params: { runId: "run-1", sessionId: "session-1" } },
      {
        method: "worker.run_completed",
        params: {
          runId: "run-1",
          sessionId: "session-1",
          status: "failed",
          error: "agent failed",
        },
      },
    ]);
    expect(activeRuns.size).toBe(0);
  });
});
