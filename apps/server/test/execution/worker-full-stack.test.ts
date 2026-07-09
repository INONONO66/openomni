import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { IngressEngine, SystemToolProvider, buildWorkerMiddleware } from "@openomni/openomni";
import { Bus, ChannelGrantStore, Storage } from "@openomni/session";
import { WorkerRun as WorkerRunProtocol } from "@openomni/protocol";
import type { Execution, Ingress, Tool } from "@openomni/protocol";

let capturedOnToolCall:
  | ((
      params: {
        callId: string;
        tool: string;
        input: Record<string, unknown>;
      },
      context?: { signal?: AbortSignal },
    ) => Promise<{ id: string; toolCallId: string; output: string; isError?: boolean }>)
  | undefined;

let mockPoolDispatch: (
  sessionId: string,
  runId: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

mock.module("@openomni/coordinator", () => ({
  createWorkerManager: (
    _config: Record<string, unknown>,
    ports: { toolRelay?: typeof capturedOnToolCall },
  ) => {
    capturedOnToolCall = ports.toolRelay;
    return {
      deliver: (runId: string, task: { sessionId: string } & Record<string, unknown>) =>
        mockPoolDispatch(task.sessionId, runId, task),
      cancel: async () => ({ cancelled: true }),
      killWorker: () => undefined,
      stats: () => ({
        workers: 1,
        active: 0,
        idle: 1,
        ready: 1,
        activeRuns: 0,
        maxActiveWorkers: 10,
      }),
      waitUntilReady: async () => undefined,
      shutdown: async () => undefined,
    };
  },
  recoverInterruptedRuns: async () => ({ recovered: 0, sessions: [] }),
}));

let createExecutionCoordinator: typeof import("../../src/execution/coordinator").createExecutionCoordinator;

beforeAll(async () => {
  ({ createExecutionCoordinator } = await import("../../src/execution/coordinator"));
});

afterAll(() => {
  mock.restore();
});

const noopCoordinator = {
  async dispatch(_sessionId: string, request: Execution.Request): Promise<Execution.Result> {
    return {
      runId: request.runId,
      sessionId: request.sessionId,
      status: "succeeded",
      output: "noop",
      finishReason: "stop",
    };
  },
};

beforeEach(() => {
  IngressEngine.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ChannelGrantStore.put({
    id: "grant-test",
    surface: "test",
    kind: "trusted_channel",
    createdBy: "act_owner",
  });
  IngressEngine.setCoordinator(noopCoordinator);
  capturedOnToolCall = undefined;
  mockPoolDispatch = async (_sessionId, _runId, params) => ({
    runId: params.runId,
    sessionId: params.sessionId,
    status: "succeeded",
    output: "pool-result",
    finishReason: "stop",
  });
});

afterEach(() => {
  IngressEngine.setCoordinator(noopCoordinator);
});

function makeDirectEvent(): Ingress.DirectEvent {
  return {
    id: crypto.randomUUID(),
    surface: "test",
    mode: "direct",
    payload: "hello",
    target: { kind: "worker" },
    meta: { actor: { role: "user" }, target: { kind: "worker" } },
    agent: {
      model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
      tools: [],
    },
  };
}

function makeRequest(overrides: Partial<Execution.Request> = {}): Execution.Request {
  return {
    runId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    mode: "direct",
    prompt: "hello",
    model: { provider: "test", id: "fixture" },
    ...overrides,
  };
}

describe("system tool provider — read/glob", () => {
  test("lists read and glob tools when workspace root is set", () => {
    const provider = new SystemToolProvider("/tmp");
    const toolNames = provider.listTools().map((t) => t.spec.name);

    expect(toolNames).toContain("read");
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("bash");
  });

  test("omits file tools when no workspace root is provided", () => {
    const provider = new SystemToolProvider();
    const toolNames = provider.listTools().map((t) => t.spec.name);

    expect(toolNames).toContain("bash");
    expect(toolNames).not.toContain("read");
    expect(toolNames).not.toContain("glob");
  });
});

describe("builtin middleware — tool permission", () => {
  function makeToolCtx(toolName: string) {
    return {
      timing: "invoke.prepare" as const,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName,
      toolCallId: crypto.randomUUID(),
      toolInput: {},
    };
  }

  test("blocks tool listed in denylist", async () => {
    const registrations = buildWorkerMiddleware({
      permissions: { action: "tool.call", denylist: ["bash"] },
    });
    const toolPermission = registrations.find((r) => r.name === "builtin:tool-permission");

    expect(toolPermission).toBeDefined();
    if (!toolPermission) throw new Error("tool permission middleware not found");

    const verdict = await toolPermission.fn(makeToolCtx("bash"));
    expect(verdict.verdict).toBe("deny");
  });

  test("allows tool not in denylist", async () => {
    const registrations = buildWorkerMiddleware({
      permissions: { action: "tool.call", denylist: ["bash"] },
    });
    const toolPermission = registrations.find((r) => r.name === "builtin:tool-permission");

    if (!toolPermission) throw new Error("tool permission middleware not found");

    const verdict = await toolPermission.fn(makeToolCtx("read"));
    expect(verdict.verdict).toBe("allow");
  });
});

describe("MCP proxy — worker.tool_call routes to generic dispatcher", () => {
  test("onToolCall callback delegates to toolDispatcher handler", async () => {
    const captured: Array<{ call: Tool.Call; signal?: AbortSignal }> = [];

    const toolDispatcher = new Map<
      string,
      (call: Tool.Call, context?: { signal?: AbortSignal }) => Promise<Tool.Result>
    >();
    toolDispatcher.set("myserver.read_file", async (call, context): Promise<Tool.Result> => {
      captured.push({ call, signal: context?.signal });
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "mcp-result",
        isError: false,
      };
    });

    createExecutionCoordinator({ workerScript: "unused", toolDispatcher });

    expect(capturedOnToolCall).toBeDefined();
    if (!capturedOnToolCall) throw new Error("onToolCall not captured by mock");

    const callId = crypto.randomUUID();
    const controller = new AbortController();
    const result = await capturedOnToolCall(
      {
        callId,
        tool: "myserver.read_file",
        input: { path: "/tmp/test.txt" },
      },
      { signal: controller.signal },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.call.id).toBe(callId);
    expect(captured[0]?.call.tool).toBe("myserver.read_file");
    expect(captured[0]?.signal).toBe(controller.signal);
    expect(result.output).toBe("mcp-result");
  });
});

describe("bus bridge — worker lifecycle events reach server Bus", () => {
  test("dispatch does not publish worker lifecycle events directly", async () => {
    const events: unknown[] = [];

    const unsubscribeStarted = Bus.subscribe(WorkerRunProtocol.Events.Started, (data) => {
      events.push(data);
    });
    const unsubscribeCompleted = Bus.subscribe(WorkerRunProtocol.Events.Completed, (data) => {
      events.push(data);
    });
    const unsubscribeFailed = Bus.subscribe(WorkerRunProtocol.Events.Failed, (data) => {
      events.push(data);
    });

    const coordinator = createExecutionCoordinator({ workerScript: "unused" });
    const request = makeRequest({ runId: "run-bus-test", sessionId: "session-bus-test" });

    await coordinator.dispatch("session-bus-test", request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(0);

    unsubscribeStarted();
    unsubscribeCompleted();
    unsubscribeFailed();
  });
});

describe("concurrent sessions with tools", () => {
  test("3 parallel dispatches all return succeeded", async () => {
    const mockCoordinator = {
      async dispatch(_sessionId: string, request: Execution.Request): Promise<Execution.Result> {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "succeeded",
          output: `handled:${request.runId}`,
          finishReason: "stop",
        };
      },
    };

    IngressEngine.setCoordinator(mockCoordinator);

    const results = await Promise.all([
      IngressEngine.ingest(makeDirectEvent()),
      IngressEngine.ingest(makeDirectEvent()),
      IngressEngine.ingest(makeDirectEvent()),
    ]);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.mode).toBe("direct");
      if (result.mode !== "direct") continue;
      expect(result.result.output).toMatch(/^handled:/);
    }
  });
});
