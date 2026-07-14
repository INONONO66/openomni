import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { NativeTool } from "@openomni/openomni";
import { PolicyEngine } from "@openomni/policy";
import { Policy, PolicyEvent, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { McpPrefixGuardMiddleware } from "../../../src/tool/mcp/mcp-prefix-guard";

type PointAuditEvent = {
  readonly pointId?: string;
  readonly pointVersion?: number;
  readonly verdict: string;
  readonly reason: string;
};

const activeCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of activeCleanups.splice(0)) cleanup();
});

function makeTool(name: string): NativeTool {
  return {
    spec: { name, inputSchema: {} },
    riskTier: 1,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    source: "mcp",
    async execute(call: Tool.Call): Promise<Tool.Result> {
      return { id: call.id, toolCallId: call.id, output: "ok" };
    },
  };
}

function collectPointAudit() {
  const evaluated: PointAuditEvent[] = [];
  const composed: PointAuditEvent[] = [];
  const unsubscribeEvaluated = Bus.subscribe(PolicyEvent.Evaluated, (event) => {
    evaluated.push(event);
  });
  const unsubscribeComposed = Bus.subscribe(PolicyEvent.DecisionComposed, (event) => {
    composed.push(event);
  });
  activeCleanups.push(unsubscribeEvaluated, unsubscribeComposed);
  return { evaluated, composed };
}

function captureCanonicalDispatch(
  captured: Array<{ readonly pointId: string; readonly context: Record<string, unknown> }>,
): void {
  const createPolicyEngine = PolicyEngine.create;
  const policyEngineSpy = spyOn(PolicyEngine, "create").mockImplementation((options) => {
    const engine = createPolicyEngine(options);
    engine.dispatch = async () => {
      throw new Error("legacy policy dispatch must not run");
    };
    const dispatchPoint = engine.dispatchPoint;
    engine.dispatchPoint = async (pointId, context) => {
      captured.push({ pointId, context });
      return dispatchPoint(pointId, context);
    };
    return engine;
  });
  activeCleanups.push(() => policyEngineSpy.mockRestore());
}

function expectPointAudit(events: ReturnType<typeof collectPointAudit>, verdict: "allow" | "deny") {
  const expectedPoint = {
    pointId: "tool.mcp.pre",
    pointVersion: Policy.PolicyPoint.Registry["tool.mcp.pre"].version,
    verdict,
  };
  expect(events.evaluated).toContainEqual(expect.objectContaining(expectedPoint));
  expect(events.composed).toContainEqual(expect.objectContaining(expectedPoint));
}

describe("McpPrefixGuardMiddleware canonical point dispatch", () => {
  it("uses canonical tool identity and emits point audit for a known tool", async () => {
    const captured: Array<{
      readonly pointId: string;
      readonly context: Record<string, unknown>;
    }> = [];
    captureCanonicalDispatch(captured);
    const events = collectPointAudit();

    const result = await McpPrefixGuardMiddleware.evaluatePreToolUse({
      call: { id: "call-known", tool: "search_query", input: { query: "policy" } },
      tools: [makeTool("search.query")],
      isServerConnected: () => true,
      traceContext: { traceId: "trace-known", sessionId: "session-known", runId: "run-known" },
    });

    expect(result.verdict).toMatchObject({ verdict: "allow", policyId: "agent.policy.composed" });
    expect(captured).toEqual([
      {
        pointId: "tool.mcp.pre",
        context: expect.objectContaining({
          sessionId: "session-known",
          runId: "run-known",
          toolId: "search.query",
          toolCallId: "call-known",
          mcpServerId: "search",
          toolInput: { query: "policy" },
          resourceDescriptor: {
            id: "tool:mcp:search.query",
            kind: "tool",
            source: { type: "mcp", serverId: "search" },
            labels: ["source.mcp"],
            capabilities: [],
            effects: [],
          },
        }),
      },
    ]);
    expectPointAudit(events, "allow");
  });

  it("derives a real attempted server prefix for an unknown dotted tool", async () => {
    const captured: Array<{
      readonly pointId: string;
      readonly context: Record<string, unknown>;
    }> = [];
    captureCanonicalDispatch(captured);
    const events = collectPointAudit();

    const result = await McpPrefixGuardMiddleware.evaluatePreToolUse({
      call: { id: "call-unknown", tool: "ghost.query", input: {} },
      tools: [],
      isServerConnected: () => true,
      traceContext: {
        traceId: "trace-unknown",
        sessionId: "session-unknown",
        runId: "run-unknown",
      },
    });

    expect(result.verdict).toMatchObject({ verdict: "deny", policyId: "agent.policy.composed" });
    expect(captured[0]).toMatchObject({
      pointId: "tool.mcp.pre",
      context: {
        toolId: "ghost.query",
        toolCallId: "call-unknown",
        mcpServerId: "ghost",
        resourceDescriptor: {
          id: "tool:mcp:ghost.query",
          kind: "tool",
          source: { type: "mcp", serverId: "ghost" },
          labels: ["source.mcp"],
          capabilities: [],
          effects: [],
        },
      },
    });
    expectPointAudit(events, "deny");
  });

  it("dispatches missing server identity through the canonical contract fail-closed path", async () => {
    const captured: Array<{
      readonly pointId: string;
      readonly context: Record<string, unknown>;
    }> = [];
    captureCanonicalDispatch(captured);
    const events = collectPointAudit();
    const isServerConnected = mock(() => true);

    const result = await McpPrefixGuardMiddleware.evaluatePreToolUse({
      call: { id: "call-unprefixed", tool: "query", input: {} },
      tools: [makeTool("query")],
      isServerConnected,
      traceContext: {
        traceId: "trace-unprefixed",
        sessionId: "session-unprefixed",
        runId: "run-unprefixed",
      },
    });

    expect(result.verdict).toMatchObject({
      verdict: "deny",
      policyId: "agent.policy.composed",
      reasonCodes: ["policy.context_missing"],
    });
    expect(captured[0]?.context).not.toHaveProperty("mcpServerId");
    expect(captured[0]).toMatchObject({
      pointId: "tool.mcp.pre",
      context: { toolId: "query", toolCallId: "call-unprefixed" },
    });
    expect(isServerConnected).not.toHaveBeenCalled();
    expectPointAudit(events, "deny");
  });

  it("emits canonical point audit when the derived MCP server is disconnected", async () => {
    const captured: Array<{
      readonly pointId: string;
      readonly context: Record<string, unknown>;
    }> = [];
    captureCanonicalDispatch(captured);
    const events = collectPointAudit();

    const result = await McpPrefixGuardMiddleware.evaluatePreToolUse({
      call: { id: "call-disconnected", tool: "search_query", input: {} },
      tools: [makeTool("search.query")],
      isServerConnected: () => false,
    });

    expect(result.verdict).toMatchObject({ verdict: "deny", policyId: "agent.policy.composed" });
    expect(result.verdict.effects).toContainEqual({
      type: "run.abort",
      reason: "MCP server not found: search",
    });
    expectPointAudit(events, "deny");
  });
});
