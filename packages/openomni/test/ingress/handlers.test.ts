import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, Ingress, Plan } from "@openomni/protocol";
import { Bus, Session, Storage, SurfaceKey } from "@openomni/session";
import { mockModelsGet, mockProviderFromModelsDevModel, resetTestState } from "./_llm-mock";

let IngressHandlers: typeof import("../../src/ingress/handlers").IngressHandlers;
let SessionBridge: typeof import("../../src/ingress/session-bridge").SessionBridge;

type CoordinatorLike = {
  dispatch(
    sessionId: string,
    request: { runId: string; sessionId: string },
  ): Promise<{
    runId: string;
    sessionId: string;
    status: string;
    output?: string;
    finishReason?: string;
    error?: string;
  }>;
};

const originalFns: {
  storePlanResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storePlanResult;
  storeDirectResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storeDirectResult;
} = {};

beforeAll(async () => {
  ({ IngressHandlers } = await import("../../src/ingress/handlers"));
  ({ SessionBridge } = await import("../../src/ingress/session-bridge"));

  originalFns.storePlanResult = SessionBridge.storePlanResult;
  originalFns.storeDirectResult = SessionBridge.storeDirectResult;
});

beforeEach(() => {
  SurfaceKey.clear();
  Storage.reset();
  Bus.reset();
  resetTestState();
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
});

afterEach(() => {
  if (originalFns.storePlanResult) {
    SessionBridge.storePlanResult = originalFns.storePlanResult;
  }
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

function createPlan(): Plan {
  return {
    planId: "plan-handlers-1",
    goal: "Deliver ingress handlers",
    steps: [
      {
        stepId: "s1",
        description: "Create handlers",
        expectedOutput: "handlers.ts",
        dependsOn: [],
      },
    ],
    createdAt: new Date("2026-03-08T00:00:00.000Z"),
    version: 1,
  };
}

function makePlanCoordinator(plan: Plan): CoordinatorLike {
  return {
    async dispatch(_sessionId, request) {
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: "succeeded",
        output: JSON.stringify({ plan }),
        finishReason: "stop",
      };
    },
  };
}

function makeDirectCoordinator(output: string): CoordinatorLike {
  return {
    async dispatch(_sessionId, request) {
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: "succeeded",
        output,
        finishReason: "stop",
      };
    },
  };
}

describe("IngressHandlers", () => {
  it("buildExecutionRequest preserves tool execution config", () => {
    const toolConfig = { workspaceRoot: "/workspace/openomni" };
    const permissions = { denylist: ["bash"] };
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

  it("handlePlan returns mode=plan with PlanResult", async () => {
    const sessionId = createSession();
    addTextMessage(sessionId, "user", "Plan this work");

    const plan = createPlan();

    const event: Ingress.InboundEvent = {
      id: "event-plan-1",
      surface: "tui",
      mode: "plan",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await IngressHandlers.handlePlan({
      sessionId,
      event,
      coordinator: makePlanCoordinator(plan),
    });

    expect(result.mode).toBe("plan");
    expect(result.sessionId).toBe(sessionId);
    expect(result.result.plan.planId).toBe(plan.planId);
  });

  it("handlePlan delegates to coordinator and stores plan result", async () => {
    const sessionId = createSession();
    const plan = createPlan();
    const storePlanResultMock = mock(() => undefined);

    SessionBridge.storePlanResult = storePlanResultMock;

    const event: Ingress.InboundEvent = {
      id: "event-plan-2",
      surface: "tui",
      mode: "plan",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        systemPrompt: "planner system",
        budget: { maxTurns: 2 },
      },
    };

    await IngressHandlers.handlePlan({
      sessionId,
      event,
      coordinator: makePlanCoordinator(plan),
    });

    expect(storePlanResultMock).toHaveBeenCalledTimes(1);
    const [calledSessionId, calledResult, calledModel] = storePlanResultMock.mock.calls[0];
    expect(calledSessionId).toBe(sessionId);
    expect(calledResult.plan.planId).toBe(plan.planId);
    expect(calledModel).toEqual(event.agent.model);
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
});
