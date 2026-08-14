import { testProviderModel } from "../../helpers/provider-model";
import { describe, expect, it, mock } from "bun:test";
import type { CanonicalAuditDispatchContextGeneric } from "@openomni/policy";
import type { RuntimeResource, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import { abortRun, allow, appendContext } from "../../helpers/policy-decision";
import { buildTurn } from "../../../src/core/execution/turn-prepare";
import { makeAgentBase, makeConfig, makeState, makeTrace } from "./lifecycle-dispatch-fixture";

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

  it("buildTurn emits budget_reassurance event when reasonCodes includes budget_reassurance", async () => {
    Bus.reset();
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

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.budgetReassuranceEvent?.type).toBe("budget_reassurance");
      expect(result.budgetWarningEvent).toBeUndefined();
    }
  });

  it("buildTurn emits budget_warning event when reasonCodes includes budget_warning", async () => {
    Bus.reset();
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

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.budgetWarningEvent?.type).toBe("budget_warning");
      expect(result.budgetReassuranceEvent).toBeUndefined();
    }
  });

  it("buildTurn does not emit budget events for unrelated inject messages", async () => {
    Bus.reset();
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

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.budgetReassuranceEvent).toBeUndefined();
      expect(result.budgetWarningEvent).toBeUndefined();
    }
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
    if (result.type === "complete") {
      expect(result.event.type).toBe("complete");
    }
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
    const descriptor: RuntimeResource.Descriptor = {
      id: "tool:skill-mcp:publish",
      kind: "tool",
      labels: ["source.skill-mcp", "skill.release-workflow"],
      capabilities: [],
      effects: [],
      source: { type: "skill-mcp", serverId: "github", skillId: "release-workflow" },
    };
    const skillTool: Tool.Spec & { readonly descriptor: RuntimeResource.Descriptor } = {
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
});
