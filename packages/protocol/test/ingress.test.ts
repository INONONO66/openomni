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

describe("Ingress meta contracts", () => {
  test("parses actor and target metadata", () => {
    const meta = Ingress.MetaSchema.parse({
      actor: {
        role: "main",
        trusted: true,
      },
      target: {
        kind: "worker",
        sessionId: "sess-1",
      },
      traceId: "trace-1",
    });

    expect(meta.actor?.role).toBe("main");
    expect(meta.actor?.trusted).toBe(true);
    expect(meta.target?.kind).toBe("worker");
    expect(meta.target?.sessionId).toBe("sess-1");
  });

  test("rejects worker target without worker identity", () => {
    expect(() =>
      Ingress.MetaSchema.parse({
        target: {
          kind: "worker",
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

describe("InboundEvent", () => {
  test("should parse direct event", () => {
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

  test("parses ADR-008 target aliases and actor metadata", () => {
    const main = Ingress.InboundEventSchema.parse({
      id: "event-main-1",
      surface: "cli",
      mode: "direct",
      target: "main",
      payload: "hello",
      meta: { actor: { role: "user", id: "u1" } },
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });
    expect(Ingress.resolveTarget(main)).toEqual({ kind: "main" });
    expect(main.meta?.actor?.role).toBe("user");

    const worker = Ingress.InboundEventSchema.parse({
      id: "event-worker-1",
      surface: "cli",
      mode: "direct",
      target: "worker:worker-7",
      payload: "continue",
      meta: { actor: { role: "main" } },
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });
    expect(Ingress.resolveTarget(worker)).toEqual({ kind: "worker", workerId: "worker-7" });
  });

  test("rejects worker target without workerId or sessionId", () => {
    expect(() =>
      Ingress.InboundEventSchema.parse({
        id: "event-worker-invalid",
        surface: "cli",
        mode: "direct",
        target: { type: "worker" },
        payload: "continue",
        agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
      }),
    ).toThrow();
  });

  test("should reject missing id", () => {
    expect(() =>
      Ingress.InboundEventSchema.parse({
        surface: "cli",
        mode: "direct",
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
