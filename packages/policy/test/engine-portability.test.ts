import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision, PolicyEvent, type RuntimeResource } from "@openomni/protocol";
import { PolicyEngine } from "@openomni/policy";

function createTestDescriptor(): RuntimeResource.Descriptor {
  return {
    id: "dispatch:test",
    kind: "dispatch",
    labels: [],
    capabilities: [],
    effects: [],
  };
}

describe("PolicyEngine portability", () => {
  it("creates independent engine instances with no shared state", async () => {
    const recorded1: Array<{ name: string; data: unknown }> = [];
    const recorded2: Array<{ name: string; data: unknown }> = [];

    const engine1 = PolicyEngine.create({
      auditEmit: (event, data) => {
        recorded1.push({ name: event.name, data });
      },
    });

    const engine2 = PolicyEngine.create({
      auditEmit: (event, data) => {
        recorded2.push({ name: event.name, data });
      },
    });

    engine1.register({
      name: "policy-1",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "engine1.policy" }),
    });

    engine2.register({
      name: "policy-2",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.deny({ policyId: "engine2.policy" }),
    });

    const ctx = {
      agentType: "resident",
      resourceDescriptor: createTestDescriptor(),
    };

    const decision1 = await engine1.dispatch("turn.start", ctx);
    const decision2 = await engine2.dispatch("turn.start", ctx);

    expect(decision1.verdict).toBe("allow");
    expect(decision2.verdict).toBe("deny");
    expect(recorded1.length).toBeGreaterThan(0);
    expect(recorded2.length).toBeGreaterThan(0);
    expect(recorded1).not.toEqual(recorded2);
  });

  it("dispatches policy and fires audit callback without Bus", async () => {
    const auditEvents: Array<{ name: string; data: unknown }> = [];

    const engine = PolicyEngine.create({
      auditEmit: (event, data) => {
        auditEvents.push({ name: event.name, data });
      },
    });

    engine.register({
      name: "test-policy",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "test.allow" }),
    });

    const decision = await engine.dispatch("turn.start", {
      agentType: "resident",
      resourceDescriptor: createTestDescriptor(),
    });

    expect(decision.verdict).toBe("allow");
    expect(auditEvents.length).toBeGreaterThan(0);
    expect(
      auditEvents.some(
        (event) =>
          event.name === PolicyEvent.Evaluated.name ||
          event.name === PolicyEvent.DecisionComposed.name ||
          event.name === Operational.Debug.name,
      ),
    ).toBe(true);
  });

  it("denies and fires audit callback on deny verdict", async () => {
    const auditEvents: Array<{ name: string; data: unknown }> = [];

    const engine = PolicyEngine.create({
      auditEmit: (event, data) => {
        auditEvents.push({ name: event.name, data });
      },
    });

    engine.register({
      name: "deny-policy",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.deny({ policyId: "test.deny" }),
    });

    const decision = await engine.dispatch("turn.start", {
      agentType: "resident",
      resourceDescriptor: createTestDescriptor(),
    });

    expect(decision.verdict).toBe("deny");
    expect(auditEvents.length).toBeGreaterThan(0);
  });

  it("runs without server, session, or agent bootstrap", async () => {
    const auditLog: string[] = [];

    const engine = PolicyEngine.create({
      auditEmit: (event) => {
        auditLog.push(event.name);
      },
    });

    engine.register({
      name: "standalone-policy",
      timing: "turn.start",
      priority: 100,
      fn: (ctx) => {
        expect(ctx.agentType).toBeDefined();
        expect(ctx.resourceDescriptor).toBeDefined();
        return PolicyDecision.allow({ policyId: "standalone" });
      },
    });

    const decision = await engine.dispatch("turn.start", {
      agentType: "resident",
      resourceDescriptor: createTestDescriptor(),
    });

    expect(decision.verdict).toBe("allow");
    expect(auditLog.length).toBeGreaterThan(0);
  });
});
