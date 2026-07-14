import { describe, expect, it } from "bun:test";
import { Policy, PolicyDecision, PolicyEvent } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";

function baseContext(): Omit<PolicyContext, "timing"> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

describe("agent legacy dispatch canonical enforcement", () => {
  it("returns a composed allow when no policy is registered", async () => {
    const engine = PolicyEngine.create();

    const verdict = await engine.dispatch("turn.start", {
      ...baseContext(),
      sessionId: "session-test",
      runId: "run-test",
      turnIndex: 0,
    });

    expect(verdict).toMatchObject({ verdict: "allow", policyId: "agent.policy.composed" });
  });

  it("audits the exact canonical MCP point selected from legacy labels", async () => {
    // Given
    const traceContext = {
      traceId: "trace-legacy-mcp",
      sessionId: "session-legacy-mcp",
      runId: "run-legacy-mcp",
    } as const;
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      traceContext,
      auditEmit: (event, data) => events.push({ name: event.name, data }),
    });
    engine.register({
      kind: "point",
      name: "canonical-mcp",
      pointIds: ["tool.mcp.pre"],
      effectCapabilities: { "tool.mcp.pre": [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "canonical-mcp" }),
    });

    // When
    await engine.dispatch(Policy.Timing.INVOKE_PREPARE, {
      ...baseContext(),
      sessionId: traceContext.sessionId,
      runId: traceContext.runId,
      toolName: "read_file",
      toolCallId: "call-legacy-mcp",
      toolInput: {},
      toolLabels: ["source.mcp"],
    });

    // Then
    const expected = {
      pointId: "tool.mcp.pre",
      pointVersion: Policy.PolicyPoint.Registry["tool.mcp.pre"].version,
    } as const;
    const evaluated = PolicyEvent.Evaluated.schema.parse(
      events.find(({ name }) => name === PolicyEvent.Evaluated.name)?.data,
    );
    const composed = PolicyEvent.DecisionComposed.schema.parse(
      events.find(({ name }) => name === PolicyEvent.DecisionComposed.name)?.data,
    );
    expect(evaluated).toMatchObject(expected);
    expect(composed).toMatchObject(expected);
  });
});
