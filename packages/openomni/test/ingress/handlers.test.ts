import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { PolicyDecision, type Execution, type Message, type Ingress } from "@openomni/protocol";
import type { PolicyRegistration } from "@openomni/agent";
import { Bus, Session, Storage, SurfaceKey, WorkerRun } from "@openomni/session";
import { mockModelsGet, mockProviderFromModelsDevModel, resetTestState } from "./_llm-mock";
import type { CoordinatorLike } from "../../src/ingress/coordinator-like";

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
  SurfaceKey.clear();
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
    title: "Handlers Test Session",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
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
      event,
      coordinator: makeDirectCoordinator(""),
    });

    expect(request.tools).toEqual(event.agent.tools);
    expect(request.toolConfig).toEqual(toolConfig);
    expect(request.permissions).toEqual(permissions);
    expect(request.policyPlan).toEqual(policyPlan);
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

    const result = await IngressHandlers.handleDirect({
      sessionId,
      event,
      coordinator: makeDirectCoordinator("direct output"),
    });

    expect(storeDirectResultMock).toHaveBeenCalledWith(
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
      event,
      coordinator: { dispatch, deliverMessage },
    });

    expect(deliverMessage).toHaveBeenCalledWith(sessionId, "adjust your plan", undefined);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await WorkerRun.listBySession(sessionId)).toHaveLength(0);
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
      event,
      coordinator: { dispatch, deliverMessage },
    });

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await WorkerRun.listBySession(sessionId))[0]?.status).toBe("succeeded");
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
      event,
      coordinator: { dispatch },
    });

    expect(result.result.finishReason).toBe("background");
    expect(JSON.parse(result.result.output)).toMatchObject({
      accepted: true,
      status: "started",
      sessionId,
    });
    expect((await WorkerRun.listBySession(sessionId))[0]?.status).toBe("starting");

    await dispatchStarted.promise;
    releaseDispatch?.();

    const deadline = Date.now() + 1_000;
    while ((await WorkerRun.listBySession(sessionId))[0]?.status !== "succeeded") {
      if (Date.now() > deadline) throw new Error("background run did not complete");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("marks starting worker runs interrupted when dispatch throws on IPC failure", async () => {
    const sessionId = createSession();
    const event: Ingress.InboundEvent = {
      id: "event-worker-start-failure",
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
      event,
      coordinator,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    const runs = await WorkerRun.listBySession(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("interrupted");
    expect(runs[0]?.error).toBe("socket closed before delivery");
  });

  it("handleDirect dispatches writeback.commit before storing output", async () => {
    const sessionId = createSession();
    const storeDirectResultMock = mock(() => undefined);
    const policyFn = mock(() =>
      PolicyDecision.allow({
        policyId: "test.writeback",
        reasonCodes: ["rewrite-writeback"],
        effects: [{ type: "writeback.rewrite", output: "policy output" }],
      }),
    );
    SessionBridge.storeDirectResult = storeDirectResultMock;

    const event: Ingress.InboundEvent = {
      id: "event-direct-policy",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };
    const policies: PolicyRegistration[] = [
      { name: "test-writeback", timing: "writeback.commit", priority: 100, fn: policyFn },
    ];

    const result = await IngressHandlers.handleDirect({
      sessionId,
      event,
      coordinator: makeDirectCoordinator("direct output"),
      policies,
    });

    expect(policyFn).toHaveBeenCalledTimes(1);
    expect(storeDirectResultMock).toHaveBeenCalledWith(
      sessionId,
      "policy output",
      event.agent.model,
    );
    expect(result.result.output).toBe("policy output");
  });

  it("treats writeback.commit deny verdict as terminal before storing output", async () => {
    const sessionId = createSession();
    const storeDirectResultMock = mock(() => undefined);
    SessionBridge.storeDirectResult = storeDirectResultMock;

    const event: Ingress.InboundEvent = {
      id: "event-direct-deny-writeback",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };
    const policies: PolicyRegistration[] = [
      {
        name: "test-deny-writeback",
        timing: "writeback.commit",
        priority: 0,
        fn: () =>
          PolicyDecision.deny({
            policyId: "test:deny-writeback",
            reasonCodes: ["writeback denied by policy"],
            effects: [{ type: "run.abort", reason: "writeback denied by policy" }],
          }),
      },
    ];

    const error = await IngressHandlers.handleDirect({
      sessionId,
      event,
      coordinator: makeDirectCoordinator("direct output"),
      policies,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("writeback denied by policy");
    expect(storeDirectResultMock).not.toHaveBeenCalled();
  });

  it("treats writeback.commit suppress effect as terminal before storing output", async () => {
    const sessionId = createSession();
    const storeDirectResultMock = mock(() => undefined);
    SessionBridge.storeDirectResult = storeDirectResultMock;

    const event: Ingress.InboundEvent = {
      id: "event-direct-suppress-writeback",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };
    const policies: PolicyRegistration[] = [
      {
        name: "test-suppress-writeback",
        timing: "writeback.commit",
        priority: 0,
        fn: () =>
          PolicyDecision.allow({
            policyId: "test:suppress-writeback",
            reasonCodes: ["writeback suppressed by policy"],
            effects: [{ type: "writeback.suppress", reason: "writeback suppressed by policy" }],
          }),
      },
    ];

    const error = await IngressHandlers.handleDirect({
      sessionId,
      event,
      coordinator: makeDirectCoordinator("direct output"),
      policies,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("writeback suppressed by policy");
    expect(storeDirectResultMock).not.toHaveBeenCalled();
  });

  it("treats writeback.commit pending verdict as terminal", async () => {
    const sessionId = createSession();
    const storeDirectResultMock = mock(() => undefined);
    SessionBridge.storeDirectResult = storeDirectResultMock;

    const event: Ingress.InboundEvent = {
      id: "event-direct-retry-writeback",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };
    const policies: PolicyRegistration[] = [
      {
        name: "test-retry-writeback",
        timing: "writeback.commit",
        priority: 0,
        fn: () =>
          PolicyDecision.pending({
            policyId: "test:retry-writeback",
            reasonCodes: ["approval required at writeback.commit"],
            effects: [{ type: "run.abort", reason: "approval required at writeback.commit" }],
          }),
      },
    ];

    const error = await IngressHandlers.handleDirect({
      sessionId,
      event,
      coordinator: makeDirectCoordinator("direct output"),
      policies,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("approval required at writeback.commit");
    expect(storeDirectResultMock).not.toHaveBeenCalled();
  });
});
