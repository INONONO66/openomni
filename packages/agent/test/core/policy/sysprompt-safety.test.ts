import { describe, expect, it, mock } from "bun:test";
import { registerAt } from "../../helpers/policy-decision";
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

    registerAt(
      engine,
      "prompt.context.pre",
      "abort-context",
      0,
      () =>
        PolicyDecision.deny({
          policyId: "test.context-aborted",
          reasonCodes: ["context-aborted"],
          effects: [{ type: "audit.annotate", annotation: "context-aborted", severity: "error" }],
        }),
      ["audit.annotate"],
    );
    registerAt(engine, "prompt.context.pre", "after", 10, after, ["prompt.inject_message"]);

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

    registerAt(
      engine,
      "prompt.context.pre",
      "deny-context",
      0,
      () =>
        PolicyDecision.deny({
          policyId: "test.context-denied",
          reasonCodes: ["context-denied"],
          effects: [{ type: "audit.annotate", annotation: "context-denied", severity: "error" }],
        }),
      ["audit.annotate"],
    );
    registerAt(engine, "prompt.context.pre", "after", 10, after, ["prompt.inject_message"]);

    const decision = await engine.dispatchPoint("prompt.context.pre", baseCtx());
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("context-denied");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("keeps transform output when no abort or deny runs", async () => {
    const engine = PolicyEngine.create();

    registerAt(
      engine,
      "prompt.context.pre",
      "transform-context",
      0,
      () =>
        PolicyDecision.allow({
          policyId: "test.transform-context",
          reasonCodes: ["transform-context"],
          effects: [
            { type: "prompt.replace", prompt: "PROMPT_A" },
            { type: "prompt.append_context", context: "prepend-a" },
            { type: "prompt.append_context", context: "append-a" },
          ],
        }),
      ["prompt.replace", "prompt.append_context"],
    );

    const result = await engine.dispatchPoint("prompt.context.pre", baseCtx());

    expect(result.verdict).toBe("allow");
    expect(result.effects).toContainEqual({ type: "prompt.replace", prompt: "PROMPT_A" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "prepend-a" });
    expect(result.effects).toContainEqual({ type: "prompt.append_context", context: "append-a" });
  });
});
