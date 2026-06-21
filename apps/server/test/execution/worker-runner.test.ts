import { describe, expect, it } from "bun:test";
import type { AgentResult, ChatAgentConfig } from "@openomni/agent";
import { InjectionQueue, WorkspaceLock } from "@openomni/openomni";
import type { Tool, WorkerBootstrap } from "@openomni/protocol";

import type { WorkerRunState } from "../../src/execution/worker-run-state";
import { WorkerRunner } from "../../src/execution/worker-runner";

type ActiveRun = NonNullable<ReturnType<WorkerRunState.ActiveRunRegistry["get"]>>;
type SpawnRunOptions = Parameters<typeof WorkerRunner.spawnRun>[0];
type WorkerRunnerEnvironment = Omit<SpawnRunOptions, "params" | "respond">;

const successfulResult: AgentResult = {
  text: "done",
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  finishReason: "stop",
};

function createSpawnOptions(
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
    const existingRun: ActiveRun = {
      sessionId: "session-1",
      controller: new AbortController(),
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

  it("exposes dispatch without polling tools for resident guidance", async () => {
    const responses: unknown[] = [];
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          workspaceRoot: "/worker/repo",
          tools: [{ name: "dispatch", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              return undefined;
            },
          },
          createAgent: (options) => ({
            async run() {
              const toolNames = options.tools?.map((tool) => tool.name) ?? [];
              const dispatchTool = options.tools?.find((tool) => tool.name === "dispatch");
              expect(toolNames).toContain("dispatch");
              expect(dispatchTool?.inputSchema).toMatchObject({
                properties: {
                  action: { const: "resident.ask" },
                  target: {
                    properties: { kind: { const: "resident" } },
                    additionalProperties: false,
                  },
                  wait: { const: true },
                },
                required: ["action", "target", "wait"],
              });
              expect(
                (dispatchTool?.inputSchema as { properties?: Record<string, unknown> }).properties
                  ?.target,
              ).not.toHaveProperty("properties.sessionId");
              expect(toolNames).not.toContain("check_inbox");
              expect(toolNames).not.toContain("ask_main");
              expect(options.systemPrompt).toContain(
                "dispatch action resident.ask with wait: true",
              );
              expect(options.systemPrompt).toContain(
                "responses from other agents arrive automatically, no polling needed",
              );
              expect(options.systemPrompt).not.toContain("use ask_main");
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
  });

  it("exposes requested child_agent tool for worker-local parallelism", async () => {
    const responses: unknown[] = [];
    const agentConfigs: ChatAgentConfig[] = [];
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          workspaceRoot: "/worker/repo",
          tools: [{ name: "child_agent", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              return undefined;
            },
          },
          createAgent: (options) => ({
            async run() {
              agentConfigs.push(options);
              const toolNames = options.tools?.map((tool) => tool.name) ?? [];
              const childAgentTool = options.tools?.find((tool) => tool.name === "child_agent");
              if (!childAgentTool) return successfulResult;
              const variants = childAgentTool.inputSchema.oneOf;
              if (!Array.isArray(variants)) throw new Error("child_agent schema missing variants");

              expect(toolNames).toContain("child_agent");
              expect(variants).toContainEqual(
                expect.objectContaining({
                  properties: expect.objectContaining({ action: { const: "spawn" } }),
                  required: ["action", "prompt"],
                }),
              );
              expect(options.systemPrompt).toContain("child_agent");
              if (!options.toolExecutor) throw new Error("tool executor missing");
              const spawn = await options.toolExecutor({
                id: "child-agent-spawn",
                tool: "child_agent",
                input: { action: "spawn", prompt: "try to escalate", tools: { all: true } },
              });
              const childId = JSON.parse(spawn.output).childId;
              await options.toolExecutor({
                id: "child-agent-await",
                tool: "child_agent",
                input: { action: "await", ids: [childId] },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(agentConfigs).toHaveLength(2);
    expect(agentConfigs[1]?.tools).toEqual([]);
  });

  it("cancels unawaited child agents when the worker run finishes", async () => {
    const responses: unknown[] = [];
    let childSignal: AbortSignal | undefined;
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "child_agent", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              return undefined;
            },
          },
          createAgent: (options) => ({
            async run() {
              const childAgentTool = options.tools?.find((tool) => tool.name === "child_agent");
              if (!childAgentTool) {
                childSignal = options.signal;
                await new Promise<never>(() => undefined);
              }
              if (!options.toolExecutor) throw new Error("tool executor missing");
              await options.toolExecutor({
                id: "child-agent-spawn",
                tool: "child_agent",
                input: { action: "spawn", prompt: "keep running" },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(childSignal?.aborted).toBe(true);
  });

  it("routes dispatch resident.ask wait requests through worker.inbound_wait IPC", async () => {
    const responses: unknown[] = [];
    const serverCalls: Array<{
      method: string;
      params?: Record<string, unknown>;
      timeoutMs?: number;
    }> = [];
    let inboundResult: Tool.Result | undefined;

    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          workspaceRoot: "/worker/repo",
          tools: [{ name: "dispatch", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call(method, params, timeoutMs) {
              serverCalls.push({ method, params, timeoutMs });
              if (method === "worker.inbound_wait") {
                return { requestId: "request-1", accepted: true, output: "approved" };
              }
              throw new Error(`unexpected server call: ${method}`);
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              inboundResult = await options.toolExecutor({
                id: "agent-inbound-call",
                tool: "dispatch",
                input: {
                  action: "resident.ask",
                  target: { kind: "resident" },
                  payload: "Need approval",
                  wait: true,
                },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(JSON.parse(inboundResult?.output ?? "{}")).toMatchObject({
      status: "completed",
      output: "approved",
    });
    expect(serverCalls).toContainEqual(
      expect.objectContaining({
        method: "worker.inbound_wait",
        params: expect.objectContaining({
          authToken: "token",
          workerId: "worker-1",
          sessionId: "session-1",
          runId: "run-1",
          callId: expect.any(String),
          payload: "Need approval",
          workspaceRoot: "/worker/repo",
        }),
        timeoutMs: 300_000,
      }),
    );
    expect(responses[0]).toMatchObject({ status: "succeeded" });
  });

  it("keeps worker-runner resident.ask scoped to Resident targets only", async () => {
    const responses: unknown[] = [];
    const serverCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let dispatchResult: Tool.Result | undefined;

    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "dispatch", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call(method, params) {
              serverCalls.push({ method, params });
              throw new Error(`unexpected server call: ${method}`);
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              dispatchResult = await options.toolExecutor({
                id: "agent-dispatch-call",
                tool: "dispatch",
                input: {
                  action: "resident.ask",
                  target: { kind: "worker", sessionId: "owner-hint-worker-session" },
                  payload: "try to route owner directly",
                  wait: true,
                },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(dispatchResult?.isError).toBe(true);
    expect(JSON.parse(dispatchResult?.output ?? "{}")).toMatchObject({
      status: "failed",
      error: "worker dispatch resident.ask requires resident target",
    });
    expect(serverCalls).toHaveLength(0);
    expect(responses[0]).toMatchObject({ status: "succeeded" });
  });

  it("wires queued responses into turn-finish prompt injection", async () => {
    const responses: unknown[] = [];
    const injectionQueue = InjectionQueue.create();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          injectionQueue,
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              const drainPolicy = options.middleware?.find(
                (registration) => registration.name === "builtin:injection-queue-drain",
              );
              if (!drainPolicy) throw new Error("injection queue drain policy missing");

              injectionQueue.enqueue("run-1", {
                messageId: "message-1",
                output: "queued response",
                timestamp: Date.now(),
              });

              const decision = await drainPolicy.fn({
                timing: "turn.finish",
                steps: [],
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                turnCount: 1,
                isCompletion: true,
                continuationCount: 0,
                elapsedMs: 0,
                traceContext: { traceId: "trace-1", runId: "run-1", sessionId: "session-1" },
              });

              expect(decision.effects).toEqual([
                { type: "prompt.inject_message", message: "queued response", role: "assistant" },
              ]);
              expect(injectionQueue.hasPending("run-1")).toBe(false);
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
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

  it("does not expose subagent as a worker delegation tool", async () => {
    const responses: unknown[] = [];
    let subagentResult: Tool.Result | undefined;
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...createValidRequest(),
          tools: [{ name: "dispatch", inputSchema: {} }],
          policyPlan: {
            policies: [
              {
                id: "builtin:tool-permission",
                required: true,
                config: { permission: { action: "tool.call", allowlist: ["dispatch"] } },
              },
            ],
            labels: ["security"],
          },
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              subagentResult = await options.toolExecutor({
                id: "agent-tool-call",
                tool: "subagent",
                input: { agentName: "child", prompt: "delegate" },
              });
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
    expect(subagentResult).toMatchObject({
      id: expect.any(String),
      toolCallId: expect.any(String),
      isError: true,
      output: "Unknown tool: subagent",
    });
  });

  it("aborts a proxied tool IPC wait without waiting for the full IPC timeout", async () => {
    const responses: unknown[] = [];
    const activeRuns = new Map<string, ActiveRun>();
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
          canonicalName: "mcp.server.slow_write",
          exposedName: "mcp_server_slow_write",
          source: "mcp",
          category: "execution",
          riskTier: 1,
          spec: { name: "mcp.server.slow_write", inputSchema: {} },
        },
      ],
    };
    const request = createValidRequest();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        {
          ...request,
          tools: [{ name: "mcp.server.slow_write", inputSchema: {} }],
        },
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          activeRuns,
          server: {
            call(method, params, timeoutMs) {
              serverCalls.push({ method, params, timeoutMs });
              if (method === "worker.tool_call") {
                activeRuns.get("run-1")?.controller.abort();
                return new Promise<unknown>(() => undefined);
              }
              if (method === "worker.tool_call_cancel") {
                return Promise.resolve({ cancelled: true, settlement: "unknown" });
              }
              throw new Error(`unexpected server call: ${method}`);
            },
            notify() {
              // lifecycle notification
            },
          },
          getBootstrap: () => bootstrap,
          createAgent: (options) => ({
            async run() {
              if (!options.toolExecutor) throw new Error("tool executor missing");
              proxiedResult = await options.toolExecutor(
                {
                  id: "agent-tool-call",
                  tool: "mcp_server_slow_write",
                  input: {},
                },
                { signal: options.signal },
              );
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(proxiedResult).toMatchObject({
      id: expect.any(String),
      toolCallId: expect.any(String),
      isError: true,
    });
    expect(proxiedResult?.output).toContain("aborted");
    expect(serverCalls).toContainEqual(
      expect.objectContaining({
        method: "worker.tool_call_cancel",
        params: expect.objectContaining({
          runId: "run-1",
          sessionId: "session-1",
          callId: expect.any(String),
        }),
        timeoutMs: 5_000,
      }),
    );
    expect(responses[0]).toMatchObject({ status: "cancelled" });
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
