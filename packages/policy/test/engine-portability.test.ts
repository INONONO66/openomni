import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { PolicyEngine } from "@openomni/policy";

function createDispatchContext() {
  return {
    agentType: "resident",
    resourceDescriptor: {
      id: "dispatch:test",
      kind: "dispatch" as const,
      labels: [],
      capabilities: [],
      effects: [],
    },
  };
}

function createAuditedEngine() {
  const events: Array<{ name: string; data: unknown }> = [];
  const engine = PolicyEngine.create({
    auditEmit: (event, data) => {
      events.push({ name: event.name, data });
    },
  });
  return { engine, events };
}

describe("PolicyEngine portability", () => {
  it("does not match a scoped legacy registration when agentType is empty", async () => {
    const engine = PolicyEngine.create();
    let invocationCount = 0;

    engine.register({
      name: "scoped-legacy",
      timing: "turn.start",
      priority: 100,
      scope: { agentType: ["resident"] },
      fn: () => {
        invocationCount++;
        return PolicyDecision.deny({ policyId: "scoped.legacy" });
      },
    });

    const decision = await engine.dispatch("turn.start", { agentType: "" });

    expect(decision.verdict).toBe("allow");
    expect(invocationCount).toBe(0);
  });

  it("accepts legacy timing registrations unchanged", async () => {
    const engine = PolicyEngine.create();

    engine.register({
      name: "legacy-registration",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.deny({ policyId: "legacy.registration" }),
    });

    const decision = await engine.dispatch("turn.start", {});

    expect(decision.verdict).toBe("deny");
  });

  it("creates independent engine instances with no shared state", async () => {
    const { engine: engine1, events: events1 } = createAuditedEngine();
    const { engine: engine2, events: events2 } = createAuditedEngine();

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

    const ctx = createDispatchContext();

    const decision1 = await engine1.dispatch("turn.start", ctx);
    const decision2 = await engine2.dispatch("turn.start", ctx);

    expect(decision1.verdict).toBe("allow");
    expect(decision2.verdict).toBe("deny");
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0]?.data).toMatchObject({
      context: { name: "policy-1", verdict: "allow" },
    });
    expect(events2[0]?.data).toMatchObject({
      context: { name: "policy-2", verdict: "deny" },
    });
  });

  it("dispatches policy and fires audit callback without Bus", async () => {
    const { engine, events } = createAuditedEngine();

    engine.register({
      name: "test-policy",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "test.allow" }),
    });

    const decision = await engine.dispatch("turn.start", createDispatchContext());

    expect(decision.verdict).toBe("allow");
    expect(events.some(({ name }) => name === Operational.Debug.name)).toBe(true);
  });

  it("denies and fires audit callback on deny verdict", async () => {
    const { engine, events } = createAuditedEngine();

    engine.register({
      name: "deny-policy",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.deny({ policyId: "test.deny" }),
    });

    const decision = await engine.dispatch("turn.start", createDispatchContext());

    expect(decision.verdict).toBe("deny");
    expect(events.some(({ name }) => name === Operational.Debug.name)).toBe(true);
  });

  it("runs without server, session, or agent bootstrap", async () => {
    const { engine, events } = createAuditedEngine();

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

    const decision = await engine.dispatch("turn.start", createDispatchContext());

    expect(decision.verdict).toBe("allow");
    expect(events.some(({ name }) => name === Operational.Debug.name)).toBe(true);
  });
});
