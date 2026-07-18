import { describe, expect, it } from "bun:test";
import { Operational, Policy, PolicyDecision } from "@openomni/protocol";
import {
  type GenericPolicyContext,
  PolicyEngine,
  type PolicyRegistrationGeneric,
} from "@openomni/policy";
import { createPolicyRegistrationStore } from "../src/engine/registration";

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
  it("resolves legacy mappings independently of mutable protocol contracts", () => {
    const timing = "dispatch.authorize" as const;
    const originalMapping = Policy.PolicyPoint.MigrationMapping[timing];

    try {
      Reflect.set(Policy.PolicyPoint.MigrationMapping, timing, ["run.lifecycle.pre"]);

      expect(PolicyEngine.resolvePolicyPoints(timing)).toEqual(["dispatch.action.pre"]);
      expect(PolicyEngine.resolvePolicyPoints("invoke.prepare", { resourceKind: "tool" })).toEqual([
        "tool.native.pre",
        "tool.mcp.pre",
      ]);
      expect(
        PolicyEngine.resolvePolicyPoints("invoke.prepare", { resourceKind: "worker" }),
      ).toEqual(["delegation.worker.pre"]);
      expect(
        PolicyEngine.resolvePolicyPoints("invoke.prepare", { resourceKind: "delegation" }),
      ).toEqual([]);
    } finally {
      Reflect.set(Policy.PolicyPoint.MigrationMapping, timing, originalMapping);
    }
  });
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

  it("snapshots negative legacy priorities and sorts them before zero", () => {
    const store = createPolicyRegistrationStore();
    const early: PolicyRegistrationGeneric<GenericPolicyContext> = {
      name: "early",
      timing: "turn.start",
      priority: -10,
      fn: () => PolicyDecision.allow({ policyId: "early" }),
    };
    const normal: PolicyRegistrationGeneric<GenericPolicyContext> = {
      name: "normal",
      timing: "turn.start",
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "normal" }),
    };

    store.register(normal);
    store.register(early);
    early.priority = 100;
    const selected = store.selectLegacy("turn.start", undefined);

    expect(selected.map(({ name }) => name)).toEqual(["early", "normal"]);
    expect(selected[0]?.priority).toBe(-10);
    expect(Object.isFrozen(selected[0])).toBe(true);
  });

  it("preserves legacy empty names and non-finite numeric priorities", () => {
    const store = createPolicyRegistrationStore();
    const registration: PolicyRegistrationGeneric<GenericPolicyContext> = {
      name: "",
      timing: "turn.start",
      priority: Number.POSITIVE_INFINITY,
      fn: () => PolicyDecision.allow({ policyId: "legacy-runtime-shape" }),
    };

    store.register(registration);
    registration.name = "changed";
    registration.priority = 0;
    const stored = store.selectLegacy("turn.start", undefined)[0];

    expect(stored?.name).toBe("");
    expect(stored?.priority).toBe(Number.POSITIVE_INFINITY);
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it("captures each external legacy timing array value once", () => {
    const store = createPolicyRegistrationStore();
    let lengthReads = 0;
    let elementReads = 0;
    const timing = new Proxy<Policy.Timing[]>(["turn.start"], {
      get: (target, property, receiver) => {
        if (property === "length") lengthReads += 1;
        if (property === "0") {
          elementReads += 1;
          return elementReads === 1 ? "turn.start" : "error";
        }
        return Reflect.get(target, property, receiver);
      },
    });

    store.register({
      name: "single-read-timing",
      timing,
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "single-read-timing" }),
    });
    const stored = store.selectLegacy("turn.start", undefined)[0];

    expect(stored?.timing).toEqual(["turn.start"]);
    expect(lengthReads).toBe(1);
    expect(elementReads).toBe(1);
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
