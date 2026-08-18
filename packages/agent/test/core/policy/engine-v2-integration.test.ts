import { describe, expect, it, mock } from "bun:test";
import { PolicyEvent, type Policy } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";
import { allow, deny, inject, rewriteToolInput } from "../../helpers/policy-decision";

function baseCtx(): Omit<PolicyContext, "timing"> & { sessionId: string; runId: string } {
  return {
    sessionId: "session",
    runId: "run",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

function systemToolDescriptor(name: string): Policy.Resource.Descriptor {
  return {
    id: `tool:${name}`,
    kind: "tool",
    labels: ["source:system"],
    capabilities: ["tool.execute"],
    effects: ["external.read"],
    source: { type: "system" },
  };
}

describe("PolicyEngine.dispatchPoint", () => {
  it("composes canonical policy decisions", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "context-note",
      pointIds: ["connection.llm.pre"],
      effectCapabilities: { "connection.llm.pre": ["prompt.inject_message"] },
      priority: 20,
      fn: () => inject("Prefer read-only tools.", "policy.context-note", "safe-default"),
    });
    engine.register({
      kind: "point",
      name: "request-budget",
      pointIds: ["connection.llm.pre"],
      effectCapabilities: { "connection.llm.pre": [] },
      priority: 10,
      fn: () => allow("policy.request-budget"),
    });

    const decision = await engine.dispatchPoint("connection.llm.pre", {
      ...baseCtx(),
      modelId: "model",
    });

    expect(decision).toMatchObject({
      policyId: "agent.policy.composed",
      verdict: "allow",
      effects: [{ type: "prompt.inject_message", message: "Prefer read-only tools." }],
      reasonCodes: ["safe-default"],
    });
    expect(typeof decision.durationMs).toBe("number");
  });

  it("fails closed when an effect is not declared for the policy point", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "bad-run-injection",
      pointIds: ["run.lifecycle.post"],
      // prompt.inject_message is not an allowed effect at run.lifecycle.post, so it
      // cannot be declared here; returning it must trip the undeclared-effect guard.
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      priority: 0,
      fn: () => inject("not valid here", "policy.bad-run", "bad-run-effect"),
    });

    const decision = await engine.dispatchPoint("run.lifecycle.post", {
      ...baseCtx(),
      runOutcome: { type: "stop" },
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.policyId).toBe("agent.policy.composed");
    // Canonical semantics: undeclared effects are denied per middleware with
    // "policy.effect_not_declared" (was composed-level "policy.effect_not_allowed").
    expect(decision.effects).toEqual([
      {
        type: "audit.annotate",
        annotation: "run.lifecycle.post: policy.effect_not_declared: prompt.inject_message",
        severity: "error",
      },
    ]);
    expect(decision.reasonCodes).toEqual(["policy.effect_not_declared"]);
  });

  it("injects run.abort when composition deny occurs at a pre-boundary point", async () => {
    const descriptor = systemToolDescriptor("shell");
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "rewrite-shell-a",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["tool.rewrite_input"] },
      priority: 0,
      fn: () => rewriteToolInput({ command: "pwd" }, "policy.rewrite-shell-a", "rewrite-shell-a"),
    });
    engine.register({
      kind: "point",
      name: "rewrite-shell-b",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["tool.rewrite_input"] },
      priority: 0,
      fn: () =>
        rewriteToolInput({ command: "whoami" }, "policy.rewrite-shell-b", "rewrite-shell-b"),
    });

    const decision = await engine.dispatchPoint("tool.native.pre", {
      ...baseCtx(),
      toolId: "shell",
      toolName: "shell",
      toolInput: { command: "ls" },
      resourceDescriptor: descriptor,
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.effects[0]).toMatchObject({ type: "run.abort" });
    expect(decision.effects.some((effect) => effect.type === "audit.annotate")).toBe(true);
  });

  it("does not inject run.abort when composition deny occurs at a post-boundary point", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "deny-run-finish",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      priority: 0,
      fn: () => deny("policy.deny-run-finish", "blocked-run-finish"),
    });

    const decision = await engine.dispatchPoint("run.lifecycle.post", {
      ...baseCtx(),
      runOutcome: { type: "stop" },
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.effects.some((effect) => effect.type === "run.abort")).toBe(false);
  });

  it("injects run.abort on undeclared-effect deny at a pre-boundary point", async () => {
    const descriptor = systemToolDescriptor("shell");
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "invalid-shell-prompt",
      pointIds: ["tool.native.pre"],
      // prompt.replace is not an allowed effect at tool.native.pre, so it cannot be
      // declared; returning it denies with the undeclared-effect guard (fail-closed).
      effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
      priority: 0,
      fn: () =>
        allow("policy.invalid-shell-prompt", "invalid-shell-prompt", [
          { type: "prompt.replace", prompt: "not allowed" },
        ]),
    });

    const decision = await engine.dispatchPoint("tool.native.pre", {
      ...baseCtx(),
      toolId: "shell",
      toolName: "shell",
      toolInput: { command: "ls" },
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
      kind: "point",
      name: "rewrite-tool-input",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["tool.rewrite_input"] },
      priority: 0,
      fn: received,
    });

    const decision = await engine.dispatchPoint("tool.native.pre", {
      ...baseCtx(),
      toolId: "shell",
      toolName: "shell",
      toolInput: { command: "ls" },
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
      const engine = PolicyEngine.create({ auditEmit: Bus.publish });
      engine.register({
        kind: "point",
        name: "deny-shell",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
        priority: 0,
        fn: () => deny("policy.deny-shell", "blocked-shell"),
      });
      engine.register({
        kind: "point",
        name: "after-deny",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: 10,
        fn: afterDeny,
      });

      const decision = await engine.dispatchPoint("tool.native.pre", {
        ...baseCtx(),
        toolId: "shell",
        toolName: "shell",
        toolInput: { command: "ls" },
        resourceDescriptor: descriptor,
        traceContext: { traceId: "trace-deny", sessionId: "sess-deny", runId: "run-1" },
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
