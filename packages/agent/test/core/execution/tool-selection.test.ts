import { describe, expect, it } from "bun:test";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import { buildTurn, createStreamRunState } from "../../../src/core/execution/stream-helpers";
import type { PolicyRegistration } from "../../../src/core/policy/types";
import type { Tool, TraceContext } from "@openomni/protocol";
import type { ChatAgentConfig, ChatAgentInput } from "../../../src/core/types";
import { abortRun, allow, filterTools } from "../../helpers/policy-decision";

function makeTools(...names: string[]): Tool.Spec[] {
  return names.map((name) => ({
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties: {} },
  }));
}

function makeLabeledTool(name: string, labels: string[]): Tool.Spec {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    labels,
  };
}

function makeConfig(tools: Tool.Spec[]): ChatAgentConfig {
  return {
    model: { provider: "test", id: "test-model" },
    tools,
    systemPrompt: "test system prompt",
  };
}

function makeTrace(): TraceContext.Type {
  return { traceId: "trace-1", sessionId: "sess-1" };
}

function makeAgentBase() {
  return { traceId: "trace-1", sessionId: "sess-1" };
}

function makeState() {
  const input: ChatAgentInput = {
    messages: [{ role: "user", content: "hello" }],
  };
  return createStreamRunState(input);
}

function filterPolicy(filteredTools: string[]): PolicyRegistration {
  return {
    name: "test-filter",
    timing: "resources.prepare",
    priority: 0,
    fn: async () => filterTools(filteredTools, "test-filter", "test-filter"),
  };
}

function abortSelectionPolicy(reason: string): PolicyRegistration {
  return {
    name: "test-abort-selection",
    timing: "resources.prepare",
    priority: 0,
    fn: async () => abortRun("test-abort-selection", reason),
  };
}

describe("resources.prepare dispatch", () => {
  it("passes all tools through when no policy is registered", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    const tools = makeTools("bash", "read", "write");
    const state = makeState();
    const config = makeConfig(tools);

    const result = await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type !== "ready") return;
    expect(result.turn.runInput.tools).toHaveLength(3);
    expect(result.turn.runInput.tools.map((t) => t.name)).toEqual(["bash", "read", "write"]);
  });

  it("filters out tools when policy returns tool.filter patterns", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register(filterPolicy(["read"]));

    const tools = makeTools("bash", "read", "write");
    const state = makeState();
    const config = makeConfig(tools);

    const result = await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type !== "ready") return;
    expect(result.turn.runInput.tools).toHaveLength(2);
    expect(result.turn.runInput.tools.map((t) => t.name)).toEqual(["bash", "write"]);
  });

  it("filters out wildcard-prefixed tool patterns", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register(filterPolicy(["dangerous.*"]));

    const tools = makeTools("dangerous.exec", "safe.read", "dangerous.write");
    const state = makeState();
    const config = makeConfig(tools);

    const result = await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type !== "ready") return;
    expect(result.turn.runInput.tools.map((t) => t.name)).toEqual(["safe.read"]);
  });

  it("returns complete result when abort verdict is returned", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register(abortSelectionPolicy("tools-restricted"));

    const tools = makeTools("bash", "read");
    const state = makeState();
    const config = makeConfig(tools);

    const result = await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("complete");
    if (result.type !== "complete") return;
    expect(result.event).toMatchObject({
      type: "complete",
      result: { guardAborted: true },
    });
  });

  it("dispatches with tool catalog labels in context", async () => {
    Bus.reset();
    let capturedCtx: Record<string, unknown> | undefined;
    const engine = PolicyEngine.create();
    engine.register({
      name: "capture-ctx",
      timing: "resources.prepare",
      priority: 0,
      fn: async (ctx) => {
        capturedCtx = ctx as unknown as Record<string, unknown>;
        return allow();
      },
    });

    const tools = [
      makeLabeledTool("bash", ["tool:bash", "capability.execute"]),
      makeLabeledTool("read", ["tool:read", "capability.read"]),
    ];
    const state = makeState();
    const config = makeConfig(tools);

    await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.timing).toBe("resources.prepare");
    const labels = capturedCtx?.labels as Array<{ value: string; source: string }>;
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((l) => l.value.includes("bash"))).toBe(true);
    expect(labels.every((l) => l.source === "tool_metadata")).toBe(true);
  });

  it("keeps all tools when transform verdict has no tools property", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "transform-no-tools",
      timing: "resources.prepare",
      priority: 0,
      fn: async () => allow("test", "test"),
    });

    const tools = makeTools("bash", "read", "write");
    const state = makeState();
    const config = makeConfig(tools);

    const result = await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type !== "ready") return;
    expect(result.turn.runInput.tools).toHaveLength(3);
  });
});
