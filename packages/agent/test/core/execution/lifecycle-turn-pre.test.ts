import { describe, expect, it, mock } from "bun:test";
import { testProviderModel } from "../../helpers/provider-model";
import type { CanonicalAuditDispatchContextGeneric } from "@openomni/policy";
import type { Policy, Tool } from "@openomni/protocol";
import { RunEvents } from "../../../src/core/execution/events";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import { abortRun, allow, appendContext } from "../../helpers/policy-decision";
import { buildTurn } from "../../../src/core/execution/turn";
import { makeAgentBase, makeConfig, makeState, makeTrace } from "./lifecycle-dispatch-fixture";

/**
 * Budget nagging leaves on the events port, which is the only channel that
 * carries it since #621. Pinned by name: the `AgentEvent` these tests used to
 * read was built on the line beside the emit, so asserting on it never proved
 * the emit happened.
 */
function collectBudgetNames(): { readonly names: string[]; readonly stop: () => void } {
  const names: string[] = [];
  const stop = Bus.observe((event) => {
    if (
      event.name === RunEvents.BudgetReassurance.name ||
      event.name === RunEvents.BudgetWarning.name
    ) {
      names.push(event.name);
    }
  });
  return { names, stop };
}

describe("buildTurn (turn.start + context.prepare + resources.prepare)", () => {
  it("dispatches turn.start and returns ready on continue", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-pre-turn",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn,
    });

    const state = makeState();
    const config = makeConfig();
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
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0] as PolicyContext;
    expect(ctx.timing).toBe("turn.start");
  });

  it("buildTurn publishes budget reassurance when the verdict carries that reason code", async () => {
    Bus.reset();
    const budget = collectBudgetNames();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-budget-reassurance",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["prompt.inject_message"] },
      priority: 100,
      fn: () =>
        allow("test-budget-reassurance", "budget_reassurance", [
          { type: "prompt.inject_message", message: "you are on track" },
        ]),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    budget.stop();

    expect(result.type).toBe("ready");
    expect(budget.names).toEqual([RunEvents.BudgetReassurance.name]);
  });

  it("buildTurn publishes a budget warning when the verdict carries that reason code", async () => {
    Bus.reset();
    const budget = collectBudgetNames();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-budget-warning",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["prompt.inject_message"] },
      priority: 100,
      fn: () =>
        allow("test-budget-warning", "budget_warning", [
          { type: "prompt.inject_message", message: "finish this section soon" },
        ]),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    budget.stop();

    expect(result.type).toBe("ready");
    expect(budget.names).toEqual([RunEvents.BudgetWarning.name]);
  });

  it("buildTurn publishes no budget event for an unrelated inject message", async () => {
    Bus.reset();
    const budget = collectBudgetNames();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-unrelated-inject",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["prompt.inject_message"] },
      priority: 100,
      fn: () =>
        allow("test-unrelated-inject", "idle_nudge", [
          {
            type: "prompt.inject_message",
            message: "[Budget Status] keep going without triggering budget events",
          },
        ]),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    budget.stop();

    expect(result.type).toBe("ready");
    expect(budget.names).toEqual([]);
  });

  it("returns complete when turn.start policy returns abort", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-pre-turn-abort",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["run.abort"] },
      priority: 100,
      fn: () => abortRun("test.abort", "pre-turn-block"),
    });

    const state = makeState();
    const result = await buildTurn(
      state,
      makeConfig(),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("complete");
  });

  it("appends turn.start context as a user message", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-turn-context",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["prompt.append_context"] },
      priority: 100,
      fn: () => appendContext("turn context", "test.context", "append"),
    });

    const state = makeState();
    const result = await buildTurn(
      state,
      makeConfig(),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    expect(state.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "turn context" }),
    );
  });

  it("dispatches skill-backed MCP tools with the descriptor server id", async () => {
    // Given
    const seen: Array<{ readonly pointId: string; readonly serverId: unknown }> = [];
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "skill-mcp-observer",
      pointIds: ["tool.mcp.pre", "tool.mcp.post"],
      effectCapabilities: { "tool.mcp.pre": [], "tool.mcp.post": [] },
      priority: 1,
      fn: (ctx: Readonly<CanonicalAuditDispatchContextGeneric<PolicyContext>>) => {
        seen.push({ pointId: ctx.pointId, serverId: Reflect.get(ctx, "mcpServerId") });
        return allow();
      },
    });
    const descriptor: Policy.Resource.Descriptor = {
      id: "tool:skill-mcp:publish",
      kind: "tool",
      labels: ["skill.release-workflow"],
      capabilities: [],
      effects: [],
      source: { type: "skill-mcp", serverId: "github", skillId: "release-workflow" },
    };
    const skillTool: Tool.Spec & { readonly descriptor: Policy.Resource.Descriptor } = {
      name: "publish",
      inputSchema: {},
      labels: descriptor.labels,
      descriptor,
    };
    const toolExecutor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: "result",
        toolCallId: call.id,
        output: "ok",
      }),
    );
    const result = await buildTurn(
      makeState(),
      makeConfig({ tools: [skillTool], toolExecutor }),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );
    if (result.type !== "ready") throw new Error("expected a prepared turn");

    // When
    const toolResult = await result.turn.runInput.toolExecutor?.({
      id: "call",
      tool: "publish",
      input: {},
    });

    // Then
    expect(toolResult?.output).toBe("ok");
    expect(toolResult?.isError).toBeUndefined();
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { pointId: "tool.mcp.pre", serverId: "github" },
      { pointId: "tool.mcp.post", serverId: "github" },
    ]);
  });

  it("routes an underscore-mangled MCP call to tool.mcp.pre — never native (#606)", async () => {
    // The tool registers under its dotted name with mcp labels and NO tool:
    // canonical label; an executor calling the underscore-mangled alias must
    // still resolve the labels — the old resolver returned the mangled name
    // unresolved, downgrading the call to the fail-open tool.native.pre.
    const seen: string[] = [];
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "mcp-route-observer",
      pointIds: ["tool.mcp.pre", "tool.mcp.post", "tool.native.pre", "tool.native.post"],
      effectCapabilities: {
        "tool.mcp.pre": [],
        "tool.mcp.post": [],
        "tool.native.pre": [],
        "tool.native.post": [],
      },
      priority: 1,
      fn: (ctx: Readonly<CanonicalAuditDispatchContextGeneric<PolicyContext>>) => {
        seen.push(ctx.pointId as string);
        return allow();
      },
    });
    const mcpTool: Tool.Spec = {
      name: "server.tool",
      inputSchema: {},
      labels: ["source:mcp", "mcp.server"],
    };
    const toolExecutor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: "result",
        toolCallId: call.id,
        output: "ok",
      }),
    );
    const result = await buildTurn(
      makeState(),
      makeConfig({ tools: [mcpTool], toolExecutor }),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );
    if (result.type !== "ready") throw new Error("expected a prepared turn");

    await result.turn.runInput.toolExecutor?.({ id: "call", tool: "server_tool", input: {} });

    expect(seen).toEqual(["tool.mcp.pre", "tool.mcp.post"]);
  });
});
