import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Execution, Message, Ingress } from "@openomni/protocol";
import { Session, Storage, WorkItemAttemptRun, WorkItemStore } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { mockModelsGet, mockProviderFromModelsDevModel, resetTestState } from "./_llm-mock";
import type { CoordinatorLike } from "../../src/ingress/coordinator-like";
import { newTraceId } from "@openomni/telemetry";

let IngressHandlers: typeof import("../../src/ingress/handlers").IngressHandlers;
let SessionBridge: typeof import("../../src/ingress/session-bridge").SessionBridge;

const originalFns: {
  storeDirectResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storeDirectResult;
} = {};

beforeAll(async () => {
  ({ IngressHandlers } = await import("../../src/ingress/handlers"));
  ({ SessionBridge } = await import("../../src/ingress/session-bridge"));

  originalFns.storeDirectResult = SessionBridge.storeDirectResult;
});

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
  resetTestState();
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
});

afterEach(() => {
  if (originalFns.storeDirectResult) {
    SessionBridge.storeDirectResult = originalFns.storeDirectResult;
  }
});

afterAll(() => {
  mock.restore();
});

function createSession(): string {
  return Session.create({
    traceId: "trace-test",
    title: "Handlers Test Session",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

// #510 D2b — the durable run record of a worker ingress dispatch is the
// WorkItem attempt projection, never a worker_run_state row.
function workRunItems(sessionId: string) {
  return WorkItemStore.list().filter(
    (item) => item.workSessionId === sessionId && item.workerRunId !== undefined,
  );
}

function addTextMessage(sessionId: string, role: "user" | "assistant", text: string): void {
  if (role === "user") {
    const message: Message.UserMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      agent: "test-user",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    };
    Session.addMessage(sessionId, message);
    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text,
    };
    Session.addPart(message.id, part);
    return;
  }

  const message: Message.AssistantMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
    agent: "test-assistant",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  Session.addMessage(sessionId, message);
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  };
  Session.addPart(message.id, part);
}

function makeDirectCoordinator(output: string): CoordinatorLike {
  return {
    async dispatch(_sessionId: string, request: Execution.Request) {
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: "succeeded" as const,
        output,
        finishReason: "stop",
      };
    },
  };
}

describe("IngressHandlers", () => {
  it("buildExecutionRequest preserves tool execution config", () => {
    const toolConfig = { workspaceRoot: "/workspace/openomni" };
    const permissions = { action: "tool.call", denylist: ["bash"] };
    const policyPlan = {
      policies: [{ id: "builtin:tool-permission", required: true }],
      labels: ["direct"],
    };
    const event: Ingress.InboundEvent = {
      id: "event-request-1",
      traceId: "trace-test",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        tools: [{ name: "bash", inputSchema: { type: "object" } }],
        toolConfig,
        permissions,
        policyPlan,
      },
    };

    const request = IngressHandlers.buildExecutionRequest({
      sessionId: "session-1",
      traceContext: { traceId: newTraceId() },
      event,
      coordinator: makeDirectCoordinator(""),
    });

    expect(request.tools).toEqual(event.agent.tools);
    expect(request.toolConfig).toEqual(toolConfig);
    expect(request.permissions).toEqual(permissions);
    expect(request.policyPlan).toEqual(policyPlan);
  });

  /**
   * The writeback is what the journal attributes to a trace. Without one the
   * record lands correlated to nothing, so the request is refused rather than
   * filed under the session id — including for the empty string, which every
   * sibling guard also rejects.
   */
  it("buildExecutionRequest refuses a context with no usable trace", () => {
    const event: Ingress.InboundEvent = {
      id: "event-traceless",
      traceId: "trace-test",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: { model: { provider: "anthropic", id: "claude-3-haiku-20240307" } },
    };

    for (const traceContext of [undefined, { traceId: "" }]) {
      expect(() =>
        IngressHandlers.buildExecutionRequest({
          sessionId: "session-1",
          ...(traceContext === undefined ? {} : { traceContext }),
          event,
          coordinator: makeDirectCoordinator(""),
        }),
      ).toThrow("ingress writeback requires a trace context");
    }
  });

  it("handleDirect dispatches via coordinator and stores output", async () => {
    const sessionId = createSession();
    addTextMessage(sessionId, "user", "hello");
    addTextMessage(sessionId, "assistant", "hi");
    addTextMessage(sessionId, "user", "summarize");

    const storeDirectResultMock = mock(() => undefined);
    SessionBridge.storeDirectResult = storeDirectResultMock;

    const event: Ingress.InboundEvent = {
      id: "event-direct-1",
      traceId: "trace-test",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        systemPrompt: "direct system",
        tools: [],
        budget: { maxTurns: 3 },
      },
    };

    const traceId = newTraceId();
    const result = await IngressHandlers.handleDirect({
      sessionId,
      traceContext: { traceId },
      event,
      coordinator: makeDirectCoordinator("direct output"),
    });

    // The writeback must be filed under the ingress trace, not a fresh one.
    expect(storeDirectResultMock).toHaveBeenCalledWith(
      traceId,
      sessionId,
      "direct output",
      event.agent.model,
    );
    expect(result).toEqual({
      mode: "direct",
      target: { kind: "resident" },
      sessionId,
      result: {
        output: "direct output",
        finishReason: "stop",
      },
    });
  });

  it("delivers messages to an active worker target without spawning a new run", async () => {
    const sessionId = createSession();
    const storeDirectResultMock = mock(() => undefined);
    const dispatch = mock(async () => {
      throw new Error("dispatch should not be called");
    });
    const deliverMessage = mock(async () => ({ accepted: true }));
    SessionBridge.storeDirectResult = storeDirectResultMock;

    const event: Ingress.InboundEvent = {
      id: "event-worker-deliver",
      traceId: "trace-test",
      surface: "tui",
      mode: "direct",
      payload: "adjust your plan",
      target: { kind: "worker", sessionId },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await IngressHandlers.handleDirect({
      sessionId,
      traceContext: { traceId: "trace-test" },
      event,
      coordinator: { dispatch, deliverMessage },
    });

    // Pin (D11): the delivery carries the inbound frame's trace.
    expect(deliverMessage).toHaveBeenCalledWith(
      sessionId,
      "adjust your plan",
      "trace-test",
      undefined,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(workRunItems(sessionId)).toHaveLength(0);
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.finishReason).toBe("delivered");
    expect(storeDirectResultMock).toHaveBeenCalled();
  });

  it("falls back to a resume run when live worker delivery is unsupported", async () => {
    const sessionId = createSession();
    const dispatch = mock(async (_sessionId: string, request: Execution.Request) => ({
      runId: request.runId,
      sessionId,
      status: "succeeded" as const,
      output: "resumed",
      finishReason: "stop",
    }));
    const deliverMessage = mock(async () => ({
      accepted: false,
      error: "live worker message delivery is not supported",
    }));

    const event: Ingress.InboundEvent = {
      id: "event-worker-deliver-fallback",
      traceId: "trace-test",
      surface: "tui",
      mode: "direct",
      payload: "adjust later",
      target: { kind: "worker", sessionId },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await IngressHandlers.handleDirect({
      sessionId,
      traceContext: { traceId: newTraceId() },
      event,
      coordinator: { dispatch, deliverMessage },
    });

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(workRunItems(sessionId)[0]?.attemptTerminal?.outcome).toBe("succeeded");
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("resumed");
  });

  it("background worker ingress returns after admission and completes durable run later", async () => {
    const sessionId = createSession();
    let releaseDispatch: (() => void) | undefined;
    const dispatchStarted = Promise.withResolvers<void>();
    const dispatch = mock(async (_sessionId: string, request: Execution.Request) => {
      dispatchStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      return {
        runId: request.runId,
        sessionId,
        status: "succeeded" as const,
        output: "background done",
        finishReason: "stop",
      };
    });

    const event: Ingress.InboundEvent = {
      id: "event-worker-background",
      traceId: "trace-test",
      surface: "tui",
      mode: "direct",
      payload: "start in background",
      target: { kind: "worker", sessionId },
      runtime: { lifecycle: "starting", background: true },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await IngressHandlers.handleDirect({
      sessionId,
      traceContext: { traceId: newTraceId() },
      event,
      coordinator: { dispatch },
    });

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.finishReason).toBe("background");
    expect(JSON.parse(result.result.output)).toMatchObject({
      accepted: true,
      status: "started",
      sessionId,
    });
    // Admission recorded the active run (attempt allocated, no terminal).
    const admitted = workRunItems(sessionId);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.currentAttemptId).toBeDefined();
    expect(admitted[0]?.attemptTerminal).toBeUndefined();
    expect(WorkItemAttemptRun.listActive(sessionId)).toHaveLength(1);

    await dispatchStarted.promise;
    releaseDispatch?.();

    const deadline = Date.now() + 1_000;
    while (workRunItems(sessionId)[0]?.attemptTerminal?.outcome !== "succeeded") {
      if (Date.now() > deadline) throw new Error("background run did not complete");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("marks starting worker runs interrupted when dispatch throws on IPC failure", async () => {
    const sessionId = createSession();
    const event: Ingress.InboundEvent = {
      id: "event-worker-start-failure",
      traceId: "trace-test",
      surface: "tui",
      mode: "direct",
      payload: "start work",
      target: { kind: "worker", sessionId },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };
    const coordinator: CoordinatorLike = {
      async dispatch() {
        throw new Error("socket closed before delivery");
      },
    };

    const error = await IngressHandlers.handleDirect({
      sessionId,
      traceContext: { traceId: newTraceId() },
      event,
      coordinator,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    const runs = workRunItems(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.attemptTerminal?.outcome).toBe("interrupted");
    expect(runs[0]?.attemptTerminal?.error).toBe("socket closed before delivery");
  });
});
