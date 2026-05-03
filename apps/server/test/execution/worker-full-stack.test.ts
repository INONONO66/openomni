import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentRegistry } from "@openomni/agent";
import { IngressEngine, SystemToolProvider, buildWorkerMiddleware } from "@openomni/openomni";
import { Bus } from "@openomni/session";
import { Subagent } from "@openomni/protocol";
import type { Execution, Ingress, Tool, WorkerBootstrap } from "@openomni/protocol";

let capturedOnToolCall:
  | ((params: {
      callId: string;
      tool: string;
      input: Record<string, unknown>;
    }) => Promise<{ id: string; toolCallId: string; output: string; isError?: boolean }>)
  | undefined;

let mockPoolDispatch: (
  sessionId: string,
  runId: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

mock.module("@openomni/coordinator", () => ({
  createWorkerPool: (config: { onToolCall?: typeof capturedOnToolCall }) => {
    capturedOnToolCall = config.onToolCall;
    return {
      dispatch: (sessionId: string, runId: string, params: Record<string, unknown>) =>
        mockPoolDispatch(sessionId, runId, params),
      getStats: () => ({ workers: 1, active: 0, idle: 1, ready: 1 }),
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
  IngressEngine.setCoordinator(noopCoordinator);
  AgentRegistry.clear();
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

describe("worker bootstrap — AgentRegistry loaded", () => {
  test("replaceAll from WorkerBootstrap.Bootstrap populates registry", () => {
    const bootstrap: WorkerBootstrap.Bootstrap = {
      configEpoch: "v1",
      agents: [
        { name: "dev", description: "Development agent", tools: { allow: ["read", "glob"] } },
        { name: "oracle", description: "Read-only reasoning agent", tools: {} },
      ],
      toolCatalog: [],
    };

    AgentRegistry.replaceAll(
      bootstrap.agents.map((a) => ({
        ...a,
        tools: a.tools.allow ?? [],
      })),
    );

    const agents = AgentRegistry.list();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name)).toContain("dev");
    expect(agents.map((a) => a.name)).toContain("oracle");
    expect(AgentRegistry.get("dev")?.tools).toEqual(["read", "glob"]);
  });
});

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

describe("builtin middleware — tool-guard", () => {
  function makeToolCtx(toolName: string) {
    return {
      timing: "pre_tool_use" as const,
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
    const toolGuard = registrations.find((r) => r.name === "builtin:tool-guard");

    expect(toolGuard).toBeDefined();
    if (!toolGuard) throw new Error("tool-guard not found");

    const verdict = await toolGuard.fn(makeToolCtx("bash"));
    expect(verdict.action).toBe("abort");
  });

  test("allows tool not in denylist", async () => {
    const registrations = buildWorkerMiddleware({
      permissions: { action: "tool.call", denylist: ["bash"] },
    });
    const toolGuard = registrations.find((r) => r.name === "builtin:tool-guard");

    if (!toolGuard) throw new Error("tool-guard not found");

    const verdict = await toolGuard.fn(makeToolCtx("read"));
    expect(verdict.action).toBe("continue");
  });
});

describe("MCP proxy — worker.tool_call routes to generic dispatcher", () => {
  test("onToolCall callback delegates to toolDispatcher handler", async () => {
    const captured: Tool.Call[] = [];

    const toolDispatcher = new Map<string, (call: Tool.Call) => Promise<Tool.Result>>();
    toolDispatcher.set("myserver.read_file", async (call: Tool.Call): Promise<Tool.Result> => {
      captured.push(call);
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
    const result = await capturedOnToolCall({
      callId,
      tool: "myserver.read_file",
      input: { path: "/tmp/test.txt" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe(callId);
    expect(captured[0].tool).toBe("myserver.read_file");
    expect(result.output).toBe("mcp-result");
  });
});

describe("bus bridge — worker lifecycle events reach server Bus", () => {
  test("dispatch publishes WorkerRunStarted event", async () => {
    let receivedEvent: { payload: { runId: string; sessionId: string } } | undefined;

    const unsub = Bus.subscribe(Subagent.Events.WorkerRunStarted, (data) => {
      receivedEvent = data;
    });

    const coordinator = createExecutionCoordinator({ workerScript: "unused" });
    const request = makeRequest({ runId: "run-bus-test", sessionId: "session-bus-test" });

    await coordinator.dispatch("tree-1", request);

    expect(receivedEvent).toBeDefined();
    expect(receivedEvent?.payload.runId).toBe("run-bus-test");
    expect(receivedEvent?.payload.sessionId).toBe("session-bus-test");

    unsub();
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
