import { describe, expect, it } from "bun:test";
import { PolicyEvent, type RuntimeResource } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { z } from "zod";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";
import { allow, rewriteToolInput } from "../../helpers/policy-decision";

type PolicyEvaluatedEvent = z.infer<typeof PolicyEvent.Evaluated.schema>;
type PolicyDecisionComposedEvent = z.infer<typeof PolicyEvent.DecisionComposed.schema>;

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

function nativeToolDescriptor(name: string): RuntimeResource.Descriptor {
  return {
    id: `tool:${name}`,
    kind: "tool",
    labels: ["source.system"],
    capabilities: ["tool.execute"],
    effects: ["external.write"],
    source: { type: "system" },
  };
}

async function flushBus(): Promise<void> {
  await Promise.resolve();
}

describe("PolicyEngine audit emission", () => {
  it("emits policy.evaluated with canonical audit context for dispatch", async () => {
    const descriptor = nativeToolDescriptor("shell");
    const evaluated: PolicyEvaluatedEvent[] = [];
    const unsub = Bus.subscribe(PolicyEvent.Evaluated, (event) => {
      evaluated.push(event);
    });

    try {
      const engine = PolicyEngine.create({
        traceContext: {
          traceId: "trace-config",
          sessionId: "sess-config",
          runId: "run-config",
          agentName: "config-agent",
        },
      });
      engine.register({
        name: "rewrite-shell",
        timing: "invoke.prepare",
        priority: 0,
        fn: () =>
          rewriteToolInput({ command: "pwd" }, "policy.rewrite-shell", "rewrite-shell-input"),
      });

      const ctx = {
        ...baseCtx(),
        toolName: "shell",
        resourceDescriptor: descriptor,
        traceContext: {
          traceId: "trace-request",
          sessionId: "sess-request",
          runId: "run-request",
          agentName: "request-agent",
        },
      };

      await engine.dispatch("invoke.prepare", ctx);
      await flushBus();

      expect(evaluated).toHaveLength(1);
      expect(evaluated[0]).toMatchObject({
        traceId: "trace-request",
        sessionId: "sess-request",
        runId: "run-request",
        policyId: "policy.rewrite-shell",
        actor: { kind: "agent", name: "request-agent", runId: "run-request" },
        action: "tool.call",
        resource: "shell",
        verdict: "allow",
        reason: "rewrite-shell-input",
        effects: [{ type: "tool.rewrite_input", input: { command: "pwd" } }],
        reasonCodes: ["rewrite-shell-input"],
        pointId: "tool.native.pre",
        pointVersion: 1,
        resourceDescriptor: descriptor,
      });
      expect(typeof evaluated[0]?.durationMs).toBe("number");
    } finally {
      unsub();
      Bus.reset();
    }
  });

  it("emits policy.decision.composed after dispatch effect composition", async () => {
    const descriptor = nativeToolDescriptor("shell");
    const evaluated: PolicyEvaluatedEvent[] = [];
    const composed: PolicyDecisionComposedEvent[] = [];
    const unsubEvaluated = Bus.subscribe(PolicyEvent.Evaluated, (event) => {
      evaluated.push(event);
    });
    const unsubComposed = Bus.subscribe(PolicyEvent.DecisionComposed, (event) => {
      composed.push(event);
    });

    try {
      const engine = PolicyEngine.create();
      engine.register({
        name: "annotate-shell",
        timing: "invoke.prepare",
        priority: 0,
        fn: () => allow("policy.annotate-shell", "shell-reviewed"),
      });
      engine.register({
        name: "rewrite-shell",
        timing: "invoke.prepare",
        priority: 10,
        fn: () =>
          rewriteToolInput({ command: "pwd" }, "policy.rewrite-shell", "rewrite-shell-input"),
      });

      const decision = await engine.dispatch("invoke.prepare", {
        ...baseCtx(),
        toolName: "shell",
        resourceDescriptor: descriptor,
        traceContext: {
          traceId: "trace-v2",
          sessionId: "sess-v2",
          runId: "run-v2",
          agentName: "audit-agent",
        },
      });
      await flushBus();

      expect(decision.effects).toEqual([{ type: "tool.rewrite_input", input: { command: "pwd" } }]);
      expect(evaluated).toHaveLength(2);
      expect(composed).toHaveLength(1);
      expect(composed[0]).toMatchObject({
        traceId: "trace-v2",
        sessionId: "sess-v2",
        runId: "run-v2",
        actor: { kind: "agent", name: "audit-agent", runId: "run-v2" },
        action: "tool.call",
        resource: "shell",
        verdict: "allow",
        reason: "shell-reviewed,rewrite-shell-input",
        effects: [{ type: "tool.rewrite_input", input: { command: "pwd" } }],
        reasonCodes: ["shell-reviewed", "rewrite-shell-input"],
        pointId: "tool.native.pre",
        pointVersion: 1,
        resourceDescriptor: descriptor,
      });
      expect(typeof composed[0]?.durationMs).toBe("number");
    } finally {
      unsubEvaluated();
      unsubComposed();
      Bus.reset();
    }
  });
});
