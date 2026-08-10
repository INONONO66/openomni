import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { IngressPolicyGate } from "../../src/ingress/policy-gate";

function inboundCtx(): IngressPolicyGate.InboundContext {
  return {
    gate: "inbound",
    surface: "test",
    mode: "direct",
    target: "resident",
    labels: [],
  };
}

function writebackCtx(): IngressPolicyGate.WritebackContext {
  return {
    gate: "writeback",
    sessionId: "session-1",
    surface: "test",
    mode: "direct",
    target: "resident",
    output: "original",
    labels: [],
  };
}

describe("IngressPolicyGate effect allowlist (#530 review)", () => {
  it("denies a composed effect outside the gate allowlist fail-closed", async () => {
    const decision = await IngressPolicyGate.evaluate(
      [
        {
          name: "test:smuggle-prompt-effect",
          gate: "inbound",
          priority: 0,
          fn: () =>
            PolicyDecision.allow({
              policyId: "test.smuggle",
              reasonCodes: ["allowed"],
              effects: [{ type: "prompt.inject_message", message: "injected" }],
            }),
        },
      ],
      inboundCtx(),
    );

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.effect_not_declared");
  });

  it("denies writeback effects smuggled through the inbound gate", async () => {
    const decision = await IngressPolicyGate.evaluate(
      [
        {
          name: "test:smuggle-rewrite",
          gate: "inbound",
          priority: 0,
          fn: () =>
            PolicyDecision.allow({
              policyId: "test.smuggle-rewrite",
              reasonCodes: ["allowed"],
              effects: [{ type: "writeback.rewrite", output: "rewritten" }],
            }),
        },
      ],
      inboundCtx(),
    );

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.effect_not_declared");
  });

  it("allows writeback.rewrite and run.abort within their gate allowlists", async () => {
    const rewrite = await IngressPolicyGate.evaluate(
      [
        {
          name: "test:rewrite",
          gate: "writeback",
          priority: 0,
          fn: () =>
            PolicyDecision.allow({
              policyId: "test.rewrite",
              reasonCodes: ["rewrite"],
              effects: [{ type: "writeback.rewrite", output: "rewritten" }],
            }),
        },
      ],
      writebackCtx(),
    );
    expect(rewrite.verdict).toBe("allow");
    expect(rewrite.effects).toContainEqual({ type: "writeback.rewrite", output: "rewritten" });

    const abort = await IngressPolicyGate.evaluate(
      [
        {
          name: "test:abort",
          gate: "inbound",
          priority: 0,
          fn: () =>
            PolicyDecision.deny({
              policyId: "test.abort",
              reasonCodes: ["denied"],
              effects: [{ type: "run.abort", reason: "denied" }],
            }),
        },
      ],
      inboundCtx(),
    );
    expect(abort.verdict).toBe("deny");
    expect(abort.reasonCodes).toContain("denied");
  });

  it("passes a frozen context to gate policies", async () => {
    let frozen = false;
    await IngressPolicyGate.evaluate(
      [
        {
          name: "test:freeze-probe",
          gate: "inbound",
          priority: 0,
          fn: (ctx) => {
            frozen = Object.isFrozen(ctx);
            return PolicyDecision.allow({ policyId: "test.freeze" });
          },
        },
      ],
      inboundCtx(),
    );
    expect(frozen).toBe(true);
  });
});
