import { describe, expect, it } from "bun:test";
import { Bus } from "../../../src/index";
import { PolicyEngine } from "../../../src/core/policy";
import { buildTurn } from "../../../src/core/execution/turn";
import type { PolicyRegistration } from "../../../src/core/policy/types";
import type { Tool } from "@openomni/protocol";
import { registerAt, abortRun, allow, filterTools } from "../../helpers/policy-decision";
import { testProviderModel } from "../../helpers/provider-model";
import { makeAgentBase, makeConfig, makeState, makeTrace } from "./lifecycle-dispatch-fixture";

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

function filterPolicy(filteredTools: string[]): PolicyRegistration {
  return {
    kind: "point",
    name: "test-filter",
    pointIds: ["tool.catalog.pre"],
    effectCapabilities: { "tool.catalog.pre": ["tool.filter"] },
    priority: 0,
    fn: () => filterTools(filteredTools, "test-filter", "test-filter"),
  };
}

function abortSelectionPolicy(reason: string): PolicyRegistration {
  return {
    kind: "point",
    name: "test-abort-selection",
    pointIds: ["tool.catalog.pre"],
    effectCapabilities: { "tool.catalog.pre": ["run.abort"] },
    priority: 0,
    fn: () => abortRun("test-abort-selection", reason),
  };
}

describe("resources.prepare dispatch", () => {
  it.each([
    {
      name: "passes all tools through when no policy is registered",
      toolNames: ["bash", "read", "write"],
      filtered: undefined,
      expected: ["bash", "read", "write"],
    },
    {
      name: "filters out tools when policy returns tool.filter patterns",
      toolNames: ["bash", "read", "write"],
      filtered: ["read"],
      expected: ["bash", "write"],
    },
    {
      name: "filters out wildcard-prefixed tool patterns",
      toolNames: ["dangerous.exec", "safe.read", "dangerous.write"],
      filtered: ["dangerous.*"],
      expected: ["safe.read"],
    },
  ] as const)("$name", async ({ toolNames, filtered, expected }) => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    if (filtered !== undefined) engine.add(filterPolicy([...filtered]));
    const config = makeConfig({
      tools: makeTools(...toolNames),
      systemPrompt: "test system prompt",
    });

    const result = await buildTurn(
      makeState(),
      config,
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type !== "ready") return;
    expect(result.turn.runInput.tools).toHaveLength(expected.length);
    expect(result.turn.runInput.tools.map((tool) => tool.name)).toEqual([...expected]);
  });

  it("returns complete result when abort verdict is returned", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    engine.add(abortSelectionPolicy("tools-restricted"));

    const tools = makeTools("bash", "read");
    const state = makeState();
    const config = makeConfig({ tools, systemPrompt: "test system prompt" });

    const result = await buildTurn(
      state,
      config,
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("complete");
    if (result.type !== "complete") return;
    expect(result.result).toMatchObject({
      guardAborted: true,
    });
  });

  it("dispatches with tool catalog labels in context", async () => {
    Bus.reset();
    let capturedCtx: Record<string, unknown> | undefined;
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "tool.catalog.pre", "capture-ctx", 0, (ctx) => {
      capturedCtx = ctx as unknown as Record<string, unknown>;
      return allow();
    });

    const tools = [
      makeLabeledTool("bash", ["tool:bash", "capability.execute"]),
      makeLabeledTool("read", ["tool:read", "capability.read"]),
    ];
    const state = makeState();
    const config = makeConfig({ tools, systemPrompt: "test system prompt" });

    await buildTurn(
      state,
      config,
      engine,
      testProviderModel,
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
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "tool.catalog.pre", "transform-no-tools", 0, () => allow("test", "test"));

    const tools = makeTools("bash", "read", "write");
    const state = makeState();
    const config = makeConfig({ tools, systemPrompt: "test system prompt" });

    const result = await buildTurn(
      state,
      config,
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type !== "ready") return;
    expect(result.turn.runInput.tools).toHaveLength(3);
  });
});
