import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Execution, Message, Ingress } from "@openomni/protocol";
import type { PolicyRegistration } from "@openomni/agent";
import { Bus, Session, Storage, SurfaceKey } from "@openomni/session";
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
      sessionId,
      result: {
        output: "direct output",
        finishReason: "stop",
      },
    });
  });

  it("handleDirect dispatches writeback.commit before storing output", async () => {
    const sessionId = createSession();
    const storeDirectResultMock = mock(() => undefined);
    const policyFn = mock(() => ({
      action: "transform" as const,
      input: { output: "policy output" },
      reason: "rewrite-writeback",
      policyId: "test.writeback",
    }));
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
        fn: () => ({
          action: "deny" as const,
          reason: "writeback denied by policy",
          policyId: "test:deny-writeback",
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

  it("fails closed when writeback.commit returns an unsupported verdict", async () => {
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
        fn: () => ({
          action: "retry" as const,
          reason: "retry is not supported at writeback.commit",
          policyId: "test:retry-writeback",
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
    expect((error as Error).message).toBe("retry is not supported at writeback.commit");
    expect(storeDirectResultMock).not.toHaveBeenCalled();
  });
});
