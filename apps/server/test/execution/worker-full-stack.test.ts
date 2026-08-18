import { beforeEach, describe, expect, test } from "bun:test";
import { createBrainEngine, SystemToolProvider, buildWorkerMiddleware } from "@openomni/openomni";
import { createGatewayRouter } from "@openomni/channels";
import { ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import type { Execution, Gateway, Tool } from "@openomni/protocol";
import {
  createExecutionCoordinator,
  type WorkerManagerFactory,
} from "../../src/execution/coordinator";

let capturedOnToolCall: Parameters<WorkerManagerFactory>[1]["toolRelay"];

let mockPoolDispatch: (
  sessionId: string,
  runId: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

const mockWorkerManagerFactory: WorkerManagerFactory = (_config, ports) => {
  capturedOnToolCall = ports.toolRelay;
  return {
    deliver: (runId: string, task: { sessionId: string } & Record<string, unknown>) =>
      mockPoolDispatch(task.sessionId, runId, task),
    send: async () => ({ sent: true }),
    cancel: async () => ({ cancelled: true }),
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
};

beforeEach(() => {
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ChannelGrantStore.put({
    id: "grant-test",
    surface: "test",
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "act_owner",
  });
  capturedOnToolCall = undefined;
  mockPoolDispatch = async (_sessionId, _runId, params) => ({
    runId: params.runId,
    sessionId: params.sessionId,
    status: "succeeded",
    output: "pool-result",
    finishReason: "stop",
  });
});

function makeDirectEvent(): Gateway.DeliveredEvent {
  return {
    id: crypto.randomUUID(),
    traceId: "trace-test",
    surface: "test",
    mode: "direct",
    payload: "hello",
    target: { kind: "worker" },
    meta: { actor: { role: "user" }, target: { kind: "worker" } },
  };
}

function makeRequest(overrides: Partial<Execution.Request> = {}): Execution.Request {
  return {
    traceId: "trace-fixture",
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
      pointId: "tool.native.pre" as const,
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
    if (toolPermission?.kind !== "point") throw new Error("tool permission middleware not found");

    const verdict = await toolPermission.fn(makeToolCtx("bash"));
    expect(verdict.verdict).toBe("deny");
  });

  test("allows tool not in denylist", async () => {
    const registrations = buildWorkerMiddleware({
      permissions: { action: "tool.call", denylist: ["bash"] },
    });
    const toolPermission = registrations.find((r) => r.name === "builtin:tool-permission");

    if (toolPermission?.kind !== "point") throw new Error("tool permission middleware not found");

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

    createExecutionCoordinator({
      workerScript: "unused",
      workerManagerFactory: mockWorkerManagerFactory,
      toolDispatcher,
    });

    expect(capturedOnToolCall).toBeDefined();
    if (!capturedOnToolCall) throw new Error("onToolCall not captured by mock");

    const callId = crypto.randomUUID();
    const controller = new AbortController();
    const result = await capturedOnToolCall(
      {
        // runId/sessionId are required by the current ToolCallParams contract;
        // the relay routes on `tool` and they do not affect the dispatcher path.
        runId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
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

describe("bus bridge — worker lifecycle stays off the Bus", () => {
  test("dispatch publishes no worker lifecycle bus events", async () => {
    // #498 K1: the worker.run.* telemetry descriptors are retired (zero
    // subscribers); run lifecycle is WorkItem attempt facts. Dispatch must
    // publish NOTHING on the Bus for a worker run.
    const events: string[] = [];
    const stopObserving = Bus.observe((descriptor) => {
      if (descriptor.name.startsWith("worker.run.")) events.push(descriptor.name);
    });

    const coordinator = createExecutionCoordinator({
      workerScript: "unused",
      workerManagerFactory: mockWorkerManagerFactory,
    });
    const request = makeRequest({ runId: "run-bus-test", sessionId: "session-bus-test" });

    await coordinator.dispatch("session-bus-test", request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(0);

    stopObserving();
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

    // #707 stage 2: router + brain composed over the Deliver seam; the
    // AgentDef the old fixture embedded now comes from the injected resolver.
    const brain = createBrainEngine({
      coordinator: mockCoordinator,
      externalAgentResolver: async () => ({
        model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
        tools: [],
      }),
    });
    const engine = createGatewayRouter({ sink: Bus.publish, deliver: brain.deliver });

    const results = await Promise.all([
      engine.ingest(makeDirectEvent()),
      engine.ingest(makeDirectEvent()),
      engine.ingest(makeDirectEvent()),
    ]);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.mode).toBe("direct");
      if (result.mode !== "direct") continue;
      if (result.kind === "dropped") throw new Error("shape");
      expect(result.result.output).toMatch(/^handled:/);
    }
  });
});
