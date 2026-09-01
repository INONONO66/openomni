import { describe, expect, it } from "bun:test";
import { Policy } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { z } from "zod";
import { PolicyEngine } from "../../../src/core/policy";
import { atPoint, deny, policyContext } from "../../helpers/policy-decision";
import { captureBusEvents } from "../../helpers/bus-event";

type PolicyEvaluatedEvent = z.infer<typeof Policy.Events.Evaluated.schema>;
type PolicyDecisionComposedEvent = z.infer<typeof Policy.Events.DecisionComposed.schema>;

function nativeToolDescriptor(name: string): Policy.Resource.Descriptor {
  return {
    id: `tool:${name}`,
    kind: "tool",
    labels: ["source:system"],
    capabilities: ["tool.execute"],
    effects: ["external.write"],
    source: { type: "system" },
  };
}

describe("PolicyEngine audit emission", () => {
  it("emits policy.evaluated with canonical audit context for blocking dispatch", async () => {
    const descriptor = nativeToolDescriptor("shell");
    const evaluated = captureBusEvents(Policy.Events.Evaluated);

    try {
      const engine = PolicyEngine.create({
        clock: Date.now,
        traceContext: {
          traceId: "trace-config",
          sessionId: "sess-config",
          runId: "run-config",
          agentName: "config-agent",
        },
        auditEmit: Bus.publish,
      });
      engine.register(
        atPoint("tool.native.pre", {
          name: "deny-shell",
          effects: ["audit.annotate"],
          priority: 0,
          fn: () => deny("policy.deny-shell", "blocked-shell"),
        }),
      );

      const ctx = {
        ...policyContext(),
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
      const [event] = (await evaluated.done) as readonly PolicyEvaluatedEvent[];

      expect(event).toMatchObject({
        traceId: "trace-request",
        sessionId: "sess-request",
        runId: "run-request",
        // Attributed to the invoked registration, not the middleware's
        // self-reported "policy.deny-shell" id.
        policyId: "deny-shell",
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
      expect(typeof event?.durationMs).toBe("number");
    } finally {
      evaluated.unsubscribe();
      Bus.reset();
    }
  });

  it("emits policy.decision.composed for blocking dispatch", async () => {
    const descriptor = nativeToolDescriptor("shell");
    const evaluated = captureBusEvents(Policy.Events.Evaluated);
    const composed = captureBusEvents(Policy.Events.DecisionComposed);

    try {
      const engine = PolicyEngine.create({ clock: Date.now, auditEmit: Bus.publish });
      engine.register(
        atPoint("tool.native.pre", {
          name: "deny-shell",
          effects: ["audit.annotate"],
          priority: 0,
          fn: () => deny("policy.deny-shell", "blocked-shell"),
        }),
      );

      const decision = await engine.dispatchPoint("tool.native.pre", {
        ...policyContext(),
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

      const evaluatedEvents = (await evaluated.done) as readonly PolicyEvaluatedEvent[];
      const composedEvents = (await composed.done) as readonly PolicyDecisionComposedEvent[];
      expect(decision.effects).toEqual([
        { type: "run.abort", reason: "blocked-shell" },
        { type: "audit.annotate", annotation: "blocked-shell", severity: "error" },
      ]);
      expect(evaluatedEvents).toHaveLength(1);
      expect(composedEvents).toHaveLength(1);
      expect(composedEvents[0]).toMatchObject({
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
      expect(typeof composedEvents[0]?.durationMs).toBe("number");
    } finally {
      evaluated.unsubscribe();
      composed.unsubscribe();
      Bus.reset();
    }
  });
});
