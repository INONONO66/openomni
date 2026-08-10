import { describe, expect, it, mock } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";

function baseCtx(): Omit<PolicyContext, "timing"> & {
  sessionId: string;
  runId: string;
  turnIndex: number;
} {
  return {
    sessionId: "session",
    runId: "run",
    turnIndex: 0,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

describe("PolicyEngine prompt.context.pre safety", () => {
  it("stops system prompt composition on abort", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() =>
      PolicyDecision.allow({
        policyId: "test.late",
        reasonCodes: ["late"],
        effects: [{ type: "prompt.inject_message", message: "should-not-append" }],
      }),
    );

    engine.register({
      kind: "point",
      name: "abort-context",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": ["audit.annotate"] },
      priority: 0,
      fn: () =>
        PolicyDecision.deny({
          policyId: "test.context-aborted",
          reasonCodes: ["context-aborted"],
          effects: [{ type: "audit.annotate", annotation: "context-aborted", severity: "error" }],
        }),
    });
    engine.register({
      kind: "point",
      name: "after",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": ["prompt.inject_message"] },
      priority: 10,
      fn: after,
    });

    const decision = await engine.dispatchPoint("prompt.context.pre", baseCtx());
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("context-aborted");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("stops system prompt composition on deny", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() =>
      PolicyDecision.allow({
        policyId: "test.late",
        reasonCodes: ["late"],
        effects: [{ type: "prompt.inject_message", message: "should-not-append" }],
      }),
    );

    engine.register({
      kind: "point",
      name: "deny-context",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": ["audit.annotate"] },
      priority: 0,
      fn: () =>
        PolicyDecision.deny({
          policyId: "test.context-denied",
          reasonCodes: ["context-denied"],
          effects: [{ type: "audit.annotate", annotation: "context-denied", severity: "error" }],
        }),
    });
    engine.register({
      kind: "point",
      name: "after",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": ["prompt.inject_message"] },
      priority: 10,
      fn: after,
    });

    const decision = await engine.dispatchPoint("prompt.context.pre", baseCtx());
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("context-denied");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("keeps transform output when no abort or deny runs", async () => {
    const engine = PolicyEngine.create();

    engine.register({
      kind: "point",
      name: "transform-context",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": ["prompt.replace", "prompt.append_context"] },
      priority: 0,
      fn: () =>
        PolicyDecision.allow({
          policyId: "test.transform-context",
          reasonCodes: ["transform-context"],
          effects: [
            { type: "prompt.replace", prompt: "PROMPT_A" },
            { type: "prompt.append_context", context: "prepend-a" },
            { type: "prompt.append_context", context: "append-a" },
          ],
        }),
    });

    const result = await engine.dispatchPoint("prompt.context.pre", baseCtx());

    expect(result.verdict).toBe("allow");
    expect(result.effects).toContainEqual({ type: "prompt.replace", prompt: "PROMPT_A" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "prepend-a" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "append-a" });
  });
});
