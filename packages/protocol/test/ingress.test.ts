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
    expect(agent.systemPrompt).toBe(undefined);
    expect(agent.tools).toBe(undefined);
    expect(agent.budget).toBe(undefined);
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
        maxToolCalls: 20,
        maxWallTimeMs: 30_000,
        maxToolRuntimeMs: 5_000,
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
    expect(agent.tools?.length).toBe(1);
    const [tool] = agent.tools ?? [];
    if (!tool) throw new Error("expected parsed tool");
    expect(tool.name).toBe("bash");
    expect(agent.budget?.maxTurns).toBe(10);
    expect(agent.budget?.maxToolCalls).toBe(20);
    expect(agent.budget?.maxWallTimeMs).toBe(30_000);
    expect(agent.budget?.maxToolRuntimeMs).toBe(5_000);
    expect(agent.permissions?.action).toBe("tool.call");
    expect(agent.permissions?.allowlist).toEqual(["bash"]);
    expect(agent.toolConfig?.workspaceRoot).toBe("/workspace/openomni");
  });

  test("should parse full canonical budget fields through direct events", () => {
    const event = Ingress.DirectEventSchema.parse({
      id: "event-budget",
      surface: "cli",
      mode: "direct",
      payload: "budgeted work",
      agent: {
        model: {
          provider: "anthropic",
          id: "claude-3-5-sonnet",
        },
        budget: {
          maxTurns: 8,
          maxToolCalls: 13,
          maxWallTimeMs: 60_000,
          maxToolRuntimeMs: 10_000,
        },
      },
    });

    expect(event.agent.budget).toEqual({
      maxTurns: 8,
      maxToolCalls: 13,
      maxWallTimeMs: 60_000,
      maxToolRuntimeMs: 10_000,
    });
  });
});

describe("Ingress meta contracts", () => {
  test("parses actor and target metadata", () => {
    const meta = Ingress.MetaSchema.parse({
      actor: {
        role: "resident",
        trusted: true,
      },
      target: {
        kind: "worker",
        sessionId: "sess-1",
      },
      traceId: "trace-1",
    });

    expect(meta.actor?.role).toBe("resident");
    expect(meta.actor?.trusted).toBe(true);
    expect(meta.target?.kind).toBe("worker");
    expect(meta.target?.sessionId).toBe("sess-1");
  });

  test("parses worker target without identity as new worker request", () => {
    const meta = Ingress.MetaSchema.parse({
      target: {
        kind: "worker",
      },
    });

    expect(meta.target).toEqual({ kind: "worker" });
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
    expectParseFailure(() =>
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
    );
  });

  test("parses ADR-008 target aliases and actor metadata", () => {
    const resident = Ingress.InboundEventSchema.parse({
      id: "event-resident-1",
      surface: "cli",
      mode: "direct",
      target: "resident",
      payload: "hello",
      meta: { actor: { role: "user", id: "u1" } },
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });
    expect(resident.target).toEqual({ kind: "resident" });
    expect(resident.meta?.actor?.role).toBe("user");

    const worker = Ingress.InboundEventSchema.parse({
      id: "event-worker-1",
      surface: "cli",
      mode: "direct",
      target: "worker:worker-7",
      payload: "continue",
      meta: { actor: { role: "resident" } },
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });
    expect(worker.target).toEqual({ kind: "worker", workerId: "worker-7" });
  });

  test("parses worker target without workerId or sessionId", () => {
    const event = Ingress.InboundEventSchema.parse({
      id: "event-worker-new",
      surface: "cli",
      mode: "direct",
      target: { type: "worker" },
      payload: "start",
      agent: { model: { provider: "anthropic", id: "claude-3-5-sonnet" } },
    });

    expect(event.target).toEqual({ kind: "worker" });
  });

  test("should reject missing id", () => {
    expectParseFailure(() =>
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
    );
  });
});

function expectParseFailure(parse: () => unknown): void {
  let failed = false;
  try {
    parse();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}
