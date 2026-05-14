import { describe, expect, it, mock } from "bun:test";
import type { RuntimeResource } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";

function baseCtx(): Omit<PolicyContext, "timing"> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

function systemToolDescriptor(name: string): RuntimeResource.Descriptor {
  return {
    id: `tool:${name}`,
    kind: "tool",
    labels: ["source.system"],
    capabilities: ["tool.execute"],
    effects: ["external.read"],
    source: { type: "system" },
  };
}

describe("PolicyEngine.dispatchV2", () => {
  it("adapts legacy verdicts and returns the composed policy decision", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "context-note",
      timing: "model.request",
      priority: 20,
      fn: () => ({ action: "inject", message: "Prefer read-only tools.", reason: "safe-default" }),
    });
    engine.register({
      name: "request-budget",
      timing: "model.request",
      priority: 10,
      fn: () => ({ action: "continue", policyId: "policy.request-budget" }),
    });

    const decision = await engine.dispatchV2("model.request", baseCtx());

    expect(decision).toEqual({
      policyId: "agent.policy.composed",
      verdict: "allow",
      effects: [{ type: "prompt.inject_message", message: "Prefer read-only tools." }],
      reasonCodes: ["safe-default"],
    });
  });

  it("fails closed when an adapted effect is not allowed at the policy point", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "bad-run-injection",
      timing: "run.start",
      priority: 0,
      fn: () => ({
        action: "inject",
        message: "not valid here",
        reason: "bad-run-effect",
        policyId: "policy.bad-run",
      }),
    });

    const decision = await engine.dispatchV2("run.start", baseCtx());

    expect(decision.verdict).toBe("deny");
    expect(decision.policyId).toBe("agent.policy.composed");
    expect(decision.effects).toEqual([
      {
        type: "audit.annotate",
        annotation:
          "policy.effect_not_allowed: prompt.inject_message is not allowed at run.lifecycle.pre",
        severity: "error",
      },
    ]);
    expect(decision.reasonCodes).toEqual(["policy.effect_not_allowed"]);
  });

  it("passes resource descriptors through the policy request when provided", async () => {
    const descriptor = systemToolDescriptor("shell");
    const received = mock((ctx: PolicyContext) => {
      const entry = Object.entries(ctx).find(([key]) => key === "resourceDescriptor");
      expect(entry?.[1]).toEqual(descriptor);
      return {
        action: "transform",
        input: { command: "pwd" },
        reason: "rewrite-shell",
        policyId: "policy.tool-rewrite",
      };
    });
    const engine = PolicyEngine.create();
    engine.register({
      name: "rewrite-tool-input",
      timing: "invoke.prepare",
      priority: 0,
      fn: received,
    });

    const decision = await engine.dispatchV2("invoke.prepare", {
      ...baseCtx(),
      toolName: "shell",
      resourceDescriptor: descriptor,
    });

    expect(received).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({
      policyId: "agent.policy.composed",
      verdict: "allow",
      effects: [{ type: "tool.rewrite_input", input: { command: "pwd" } }],
      reasonCodes: ["rewrite-shell"],
    });
  });
});
