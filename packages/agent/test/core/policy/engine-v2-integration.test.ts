import { describe, expect, it, mock } from "bun:test";
import { Policy } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";
import {
  atPoint,
  registerAt,
  allow,
  deny,
  inject,
  rewriteToolInput,
  runContext,
} from "../../helpers/policy-decision";

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
    registerAt(
      engine,
      "connection.llm.pre",
      "context-note",
      20,
      () => inject("Prefer read-only tools.", "policy.context-note", "safe-default"),
      ["prompt.inject_message"],
    );
    registerAt(engine, "connection.llm.pre", "request-budget", 10, () =>
      allow("policy.request-budget"),
    );

    const decision = await engine.dispatchPoint("connection.llm.pre", {
      ...runContext(),
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
    registerAt(engine, "run.lifecycle.post", {
      name: "bad-run-injection",
      effects: ["audit.annotate"],
      priority: 0,
      fn: () => inject("not valid here", "policy.bad-run", "bad-run-effect"),
    });

    const decision = await engine.dispatchPoint("run.lifecycle.post", {
      ...runContext(),
      runOutcome: { type: "stop" },
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.policyId).toBe("agent.policy.composed");
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
    registerAt(
      engine,
      "tool.native.pre",
      "rewrite-shell-a",
      0,
      () => rewriteToolInput({ command: "pwd" }, "policy.rewrite-shell-a", "rewrite-shell-a"),
      ["tool.rewrite_input"],
    );
    registerAt(
      engine,
      "tool.native.pre",
      "rewrite-shell-b",
      0,
      () => rewriteToolInput({ command: "whoami" }, "policy.rewrite-shell-b", "rewrite-shell-b"),
      ["tool.rewrite_input"],
    );

    const decision = await engine.dispatchPoint("tool.native.pre", {
      ...runContext(),
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
    registerAt(
      engine,
      "run.lifecycle.post",
      "deny-run-finish",
      0,
      () => deny("policy.deny-run-finish", "blocked-run-finish"),
      ["audit.annotate"],
    );

    const decision = await engine.dispatchPoint("run.lifecycle.post", {
      ...runContext(),
      runOutcome: { type: "stop" },
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.effects.some((effect) => effect.type === "run.abort")).toBe(false);
  });

  it("injects run.abort on undeclared-effect deny at a pre-boundary point", async () => {
    const descriptor = systemToolDescriptor("shell");
    const engine = PolicyEngine.create();
    registerAt(engine, "tool.native.pre", {
      name: "invalid-shell-prompt",
      effects: ["audit.annotate"],
      priority: 0,
      fn: () =>
        allow("policy.invalid-shell-prompt", "invalid-shell-prompt", [
          { type: "prompt.replace", prompt: "not allowed" },
        ]),
    });

    const decision = await engine.dispatchPoint("tool.native.pre", {
      ...runContext(),
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
    registerAt(engine, "tool.native.pre", "rewrite-tool-input", 0, received, [
      "tool.rewrite_input",
    ]);

    const decision = await engine.dispatchPoint("tool.native.pre", {
      ...runContext(),
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
    const unsubEvaluated = Bus.subscribe(Policy.Events.Evaluated, (event) => {
      evaluated.push(event);
    });
    const unsubComposed = Bus.subscribe(Policy.Events.DecisionComposed, (event) => {
      composed.push(event);
    });

    try {
      const afterDeny = mock(() => allow());
      const engine = PolicyEngine.create({ auditEmit: Bus.publish });
      engine.register(
        atPoint("tool.native.pre", {
          name: "deny-shell",
          effects: ["audit.annotate"],
          priority: 0,
          fn: () => deny("policy.deny-shell", "blocked-shell"),
        }),
      );
      engine.register(
        atPoint("tool.native.pre", {
          name: "after-deny",
          priority: 10,
          fn: afterDeny,
        }),
      );

      const decision = await engine.dispatchPoint("tool.native.pre", {
        ...runContext(),
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
