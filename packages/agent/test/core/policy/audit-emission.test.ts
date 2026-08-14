import { describe, expect, it } from "bun:test";
import { PolicyEvent, type RuntimeResource } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { z } from "zod";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";
import { deny } from "../../helpers/policy-decision";

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
  it("emits policy.evaluated with canonical audit context for blocking dispatch", async () => {
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
        auditEmit: Bus.publish,
      });
      engine.register({
        kind: "point",
        name: "deny-shell",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
        priority: 0,
        fn: () => deny("policy.deny-shell", "blocked-shell"),
      });

      const ctx = {
        ...baseCtx(),
        sessionId: "sess-request",
        runId: "run-request",
        toolId: "shell",
        toolName: "shell",
        toolInput: { command: "ls" },
        resourceDescriptor: descriptor,
        traceContext: {
          traceId: "trace-request",
          sessionId: "sess-request",
          runId: "run-request",
          agentName: "request-agent",
        },
      };

      await engine.dispatchPoint("tool.native.pre", ctx);
      await flushBus();

      expect(evaluated).toHaveLength(1);
      expect(evaluated[0]).toMatchObject({
        traceId: "trace-request",
        sessionId: "sess-request",
        runId: "run-request",
        policyId: "policy.deny-shell",
        actor: { kind: "agent", name: "request-agent", runId: "run-request" },
        action: "tool.call",
        resource: "shell",
        verdict: "deny",
        reason: "blocked-shell",
        effects: [{ type: "audit.annotate", annotation: "blocked-shell", severity: "error" }],
        reasonCodes: ["blocked-shell"],
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

  it("emits policy.decision.composed for blocking dispatch", async () => {
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
      const engine = PolicyEngine.create({ auditEmit: Bus.publish });
      engine.register({
        kind: "point",
        name: "deny-shell",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
        priority: 0,
        fn: () => deny("policy.deny-shell", "blocked-shell"),
      });

      const decision = await engine.dispatchPoint("tool.native.pre", {
        ...baseCtx(),
        sessionId: "sess-v2",
        runId: "run-v2",
        toolId: "shell",
        toolName: "shell",
        toolInput: { command: "ls" },
        resourceDescriptor: descriptor,
        traceContext: {
          traceId: "trace-v2",
          sessionId: "sess-v2",
          runId: "run-v2",
          agentName: "audit-agent",
        },
      });
      await flushBus();

      expect(decision.effects).toEqual([
        { type: "run.abort", reason: "blocked-shell" },
        { type: "audit.annotate", annotation: "blocked-shell", severity: "error" },
      ]);
      expect(evaluated).toHaveLength(1);
      expect(composed).toHaveLength(1);
      expect(composed[0]).toMatchObject({
        traceId: "trace-v2",
        sessionId: "sess-v2",
        runId: "run-v2",
        actor: { kind: "agent", name: "audit-agent", runId: "run-v2" },
        action: "tool.call",
        resource: "shell",
        verdict: "deny",
        reason: "blocked-shell",
        effects: [
          { type: "run.abort", reason: "blocked-shell" },
          { type: "audit.annotate", annotation: "blocked-shell", severity: "error" },
        ],
        reasonCodes: ["blocked-shell"],
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
