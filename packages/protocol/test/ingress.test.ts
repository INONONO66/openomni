import { describe, test, expect } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

describe("AgentDef", () => {
  test("should parse agent with only model required", () => {
    const agent = Ingress.AgentDefSchema.parse({
      model: {
        provider: "anthropic",
        id: "claude-3-5-sonnet",
      },
    });
    expect(agent.model.provider).toBe("anthropic");
    expect(agent.model.id).toBe("claude-3-5-sonnet");
    expect(agent.systemPrompt).toBeUndefined();
    expect(agent.tools).toBeUndefined();
    expect(agent.budget).toBeUndefined();
  });

  test("should parse agent with optional fields", () => {
    const agent = Ingress.AgentDefSchema.parse({
      model: {
        provider: "openai",
        id: "gpt-4",
      },
      systemPrompt: "You are a helpful assistant",
      tools: [
        {
          name: "bash",
          description: "Execute bash commands",
          inputSchema: { command: { type: "string" } },
        },
      ],
      budget: {
        maxTurns: 10,
      },
      permissions: {
        action: "tool.call",
        allowlist: ["bash"],
      },
      toolConfig: {
        workspaceRoot: "/workspace/openomni",
      },
    });
    expect(agent.systemPrompt).toBe("You are a helpful assistant");
    expect(agent.tools).toHaveLength(1);
    const [tool] = agent.tools ?? [];
    if (!tool) throw new Error("expected parsed tool");
    expect(tool.name).toBe("bash");
    expect(agent.budget?.maxTurns).toBe(10);
    expect(agent.permissions?.action).toBe("tool.call");
    expect(agent.permissions?.allowlist).toEqual(["bash"]);
    expect(agent.toolConfig?.workspaceRoot).toBe("/workspace/openomni");
  });
});

describe("PlanEvent", () => {
  test("should parse valid plan event with agent", () => {
    const event = Ingress.PlanEventSchema.parse({
      id: "event-1",
      surface: "cli",
      mode: "plan",
      payload: { goal: "Build API" },
      agent: {
        model: {
          provider: "anthropic",
          id: "claude-3-5-sonnet",
        },
      },
    });
    expect(event.mode).toBe("plan");
    expect(event.id).toBe("event-1");
    expect(event.surface).toBe("cli");
    expect(event.agent.model.provider).toBe("anthropic");
  });

  test("should parse plan event with optional fields", () => {
    const event = Ingress.PlanEventSchema.parse({
      id: "event-2",
      surface: "api",
      channel: "webhook",
      workspace: "workspace-1",
      userId: "user-123",
      mode: "plan",
      payload: { goal: "Deploy service" },
      meta: { source: "github" },
      agent: {
        model: {
          provider: "openai",
          id: "gpt-4",
        },
        systemPrompt: "You are a planning agent",
      },
    });
    expect(event.channel).toBe("webhook");
    expect(event.workspace).toBe("workspace-1");
    expect(event.userId).toBe("user-123");
    expect(event.meta?.source).toBe("github");
  });

  test("should reject plan event missing mode", () => {
    expect(() =>
      Ingress.PlanEventSchema.parse({
        id: "event-1",
        surface: "cli",
        payload: { goal: "Build API" },
        agent: {
          model: {
            provider: "anthropic",
            id: "claude-3-5-sonnet",
          },
        },
      }),
    ).toThrow();
  });

  test("should reject plan event missing agent", () => {
    expect(() =>
      Ingress.PlanEventSchema.parse({
        id: "event-1",
        surface: "cli",
        mode: "plan",
        payload: { goal: "Build API" },
      }),
    ).toThrow();
  });

  test("should reject plan event missing surface", () => {
    expect(() =>
      Ingress.PlanEventSchema.parse({
        id: "event-1",
        mode: "plan",
        payload: { goal: "Build API" },
        agent: {
          model: {
            provider: "anthropic",
            id: "claude-3-5-sonnet",
          },
        },
      }),
    ).toThrow();
  });
});

describe("DirectEvent", () => {
  test("should parse valid direct event with agent", () => {
    const event = Ingress.DirectEventSchema.parse({
      id: "event-1",
      surface: "cli",
      mode: "direct",
      payload: { query: "What is 2+2?" },
      agent: {
        model: {
          provider: "anthropic",
          id: "claude-3-5-sonnet",
        },
      },
    });
    expect(event.mode).toBe("direct");
    expect(event.agent.model.id).toBe("claude-3-5-sonnet");
  });
});

describe("InboundEvent (discriminated union)", () => {
  test("should parse plan event via discriminated union", () => {
    const event = Ingress.InboundEventSchema.parse({
      id: "event-1",
      surface: "cli",
      mode: "plan",
      payload: { goal: "Build API" },
      agent: {
        model: {
          provider: "anthropic",
          id: "claude-3-5-sonnet",
        },
      },
    });
    expect(event.mode).toBe("plan");
  });

  test("should parse direct event via discriminated union", () => {
    const event = Ingress.InboundEventSchema.parse({
      id: "event-1",
      surface: "cli",
      mode: "direct",
      payload: { query: "What is 2+2?" },
      agent: {
        model: {
          provider: "anthropic",
          id: "claude-3-5-sonnet",
        },
      },
    });
    expect(event.mode).toBe("direct");
  });

  test("should reject invalid mode value", () => {
    expect(() =>
      Ingress.InboundEventSchema.parse({
        id: "event-1",
        surface: "cli",
        mode: "auto",
        payload: { goal: "Build API" },
        agent: {
          model: {
            provider: "anthropic",
            id: "claude-3-5-sonnet",
          },
        },
      }),
    ).toThrow();
  });

  test("should reject missing id", () => {
    expect(() =>
      Ingress.InboundEventSchema.parse({
        surface: "cli",
        mode: "plan",
        payload: { goal: "Build API" },
        agent: {
          model: {
            provider: "anthropic",
            id: "claude-3-5-sonnet",
          },
        },
      }),
    ).toThrow();
  });
});
