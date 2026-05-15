import { describe, expect, it, mock } from "bun:test";
import { PolicyEvent, type RuntimeResource } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";
import { allow, deny, inject, rewriteToolInput } from "../../helpers/policy-decision";

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

describe("PolicyEngine.dispatch", () => {
  it("composes canonical policy decisions", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "context-note",
      timing: "model.request",
      priority: 20,
      fn: () => inject("Prefer read-only tools.", "policy.context-note", "safe-default"),
    });
    engine.register({
      name: "request-budget",
      timing: "model.request",
      priority: 10,
      fn: () => allow("policy.request-budget"),
    });

    const decision = await engine.dispatch("model.request", baseCtx());

    expect(decision).toMatchObject({
      policyId: "agent.policy.composed",
      verdict: "allow",
      effects: [{ type: "prompt.inject_message", message: "Prefer read-only tools." }],
      reasonCodes: ["safe-default"],
    });
    expect(typeof decision.durationMs).toBe("number");
  });

  it("fails closed when an effect is not allowed at the policy point", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "bad-run-injection",
      timing: "run.finish",
      priority: 0,
      fn: () => inject("not valid here", "policy.bad-run", "bad-run-effect"),
    });

    const decision = await engine.dispatch("run.finish", baseCtx());

    expect(decision.verdict).toBe("deny");
    expect(decision.policyId).toBe("agent.policy.composed");
    expect(decision.effects).toEqual([
      {
        type: "audit.annotate",
        annotation:
          "policy.effect_not_allowed: prompt.inject_message is not allowed at run.lifecycle.post",
        severity: "error",
      },
    ]);
    expect(decision.reasonCodes).toEqual(["policy.effect_not_allowed"]);
  });

  it("injects run.abort when composition deny occurs at pre-boundary timing", async () => {
    const descriptor = systemToolDescriptor("shell");
    const engine = PolicyEngine.create();
    engine.register({
      name: "rewrite-shell-a",
      timing: "invoke.prepare",
      priority: 0,
      fn: () => rewriteToolInput({ command: "pwd" }, "policy.rewrite-shell-a", "rewrite-shell-a"),
    });
    engine.register({
      name: "rewrite-shell-b",
      timing: "invoke.prepare",
      priority: 0,
      fn: () =>
        rewriteToolInput({ command: "whoami" }, "policy.rewrite-shell-b", "rewrite-shell-b"),
    });

    const decision = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
      toolName: "shell",
      resourceDescriptor: descriptor,
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.effects[0]).toMatchObject({ type: "run.abort" });
    expect(decision.effects.some((effect) => effect.type === "audit.annotate")).toBe(true);
  });

  it("does not inject run.abort when composition deny occurs at post-boundary timing", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-run-finish",
      timing: "run.finish",
      priority: 0,
      fn: () => deny("policy.deny-run-finish", "blocked-run-finish"),
    });

    const decision = await engine.dispatch("run.finish", baseCtx());

    expect(decision.verdict).toBe("deny");
    expect(decision.effects.some((effect) => effect.type === "run.abort")).toBe(false);
  });

  it("injects run.abort on validation failure deny at pre-boundary timing", async () => {
    const descriptor = systemToolDescriptor("shell");
    const engine = PolicyEngine.create();
    engine.register({
      name: "invalid-shell-prompt",
      timing: "invoke.prepare",
      priority: 0,
      fn: () =>
        allow("policy.invalid-shell-prompt", "invalid-shell-prompt", [
          { type: "prompt.replace", prompt: "not allowed" },
        ]),
    });

    const decision = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
      toolName: "shell",
      resourceDescriptor: descriptor,
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.effects[0]).toMatchObject({ type: "run.abort" });
  });

  it("passes resource descriptors through the policy request when provided", async () => {
    const descriptor = systemToolDescriptor("shell");
    const received = mock((ctx: PolicyContext) => {
      const entry = Object.entries(ctx).find(([key]) => key === "resourceDescriptor");
      expect(entry?.[1]).toEqual(descriptor);
      return rewriteToolInput({ command: "pwd" }, "policy.tool-rewrite", "rewrite-shell");
    });
    const engine = PolicyEngine.create();
    engine.register({
      name: "rewrite-tool-input",
      timing: "invoke.prepare",
      priority: 0,
      fn: received,
    });

    const decision = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
      toolName: "shell",
      resourceDescriptor: descriptor,
    });

    expect(received).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      policyId: "agent.policy.composed",
      verdict: "allow",
      effects: [{ type: "tool.rewrite_input", input: { command: "pwd" } }],
      reasonCodes: ["rewrite-shell"],
    });
    expect(typeof decision.durationMs).toBe("number");
  });

  it("stops evaluation after deny while still emitting audit events", async () => {
    const descriptor = systemToolDescriptor("shell");
    const evaluated: unknown[] = [];
    const composed: unknown[] = [];
    const unsubEvaluated = Bus.subscribe(PolicyEvent.Evaluated, (event) => {
      evaluated.push(event);
    });
    const unsubComposed = Bus.subscribe(PolicyEvent.DecisionComposed, (event) => {
      composed.push(event);
    });

    try {
      const afterDeny = mock(() => allow());
      const engine = PolicyEngine.create();
      engine.register({
        name: "deny-shell",
        timing: "invoke.prepare",
        priority: 0,
        fn: () => deny("policy.deny-shell", "blocked-shell"),
      });
      engine.register({
        name: "after-deny",
        timing: "invoke.prepare",
        priority: 10,
        fn: afterDeny,
      });

      const decision = await engine.dispatch("invoke.prepare", {
        ...baseCtx(),
        toolName: "shell",
        resourceDescriptor: descriptor,
        traceContext: {
          traceId: "trace-deny",
          sessionId: "sess-deny",
        },
      });
      await Promise.resolve();

      expect(afterDeny).toHaveBeenCalledTimes(0);
      expect(decision).toMatchObject({
        policyId: "agent.policy.composed",
        verdict: "deny",
        effects: [
          { type: "run.abort", reason: "blocked-shell" },
          { type: "audit.annotate", annotation: "blocked-shell", severity: "error" },
        ],
        reasonCodes: ["blocked-shell"],
      });
      expect(typeof decision.durationMs).toBe("number");
      expect(evaluated).toHaveLength(1);
      expect(composed).toHaveLength(1);
    } finally {
      unsubEvaluated();
      unsubComposed();
      Bus.reset();
    }
  });
});
