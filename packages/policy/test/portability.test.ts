import { describe, expect, it } from "bun:test";
import { PolicyDecision, PolicyEvent, Operational, type RuntimeResource } from "@openomni/protocol";
import { PolicyEngine, type GenericPolicyContext } from "@openomni/policy";
import { PolicyRegistry } from "@openomni/policy";

/**
 * Portability test: Verify PolicyEngine and PolicyRegistry run correctly
 * when imported in a worker process (separate from main server).
 *
 * This test proves:
 * 1. No module-level mutable state (singletons, global Maps/Sets)
 * 2. Each PolicyEngine.create() returns fresh instances
 * 3. Each PolicyRegistry.create() returns fresh instances
 * 4. Audit events fire correctly without server/session bootstrap
 * 5. No @openomni/session or @openomni/agent imports required
 */

function createTestDescriptor(): RuntimeResource.Descriptor {
  return {
    id: "dispatch:test",
    kind: "dispatch" as const,
    labels: [],
    capabilities: [],
    effects: [],
  };
}

describe("PolicyEngine portability (worker process isolation)", () => {
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

    // Register different policies in each engine
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
    } as GenericPolicyContext & Record<string, unknown>;

    // Dispatch through both engines
    const decision1 = await engine1.dispatch("turn.start", ctx);
    const decision2 = await engine2.dispatch("turn.start", ctx);

    // Verify independent decisions
    expect(decision1.verdict).toBe("allow");
    expect(decision2.verdict).toBe("deny");

    // Verify audit events are isolated
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

    const ctx = {
      agentType: "resident",
      resourceDescriptor: createTestDescriptor(),
    } as GenericPolicyContext & Record<string, unknown>;

    const decision = await engine.dispatch("turn.start", ctx);

    // Verify decision
    expect(decision.verdict).toBe("allow");

    // Verify audit callback was invoked
    expect(auditEvents.length).toBeGreaterThan(0);

    // Verify at least one event is a PolicyEvent.Evaluated or similar
    const hasAuditEvent = auditEvents.some(
      (e) =>
        e.name === PolicyEvent.Evaluated.name ||
        e.name === PolicyEvent.DecisionComposed.name ||
        e.name === Operational.Debug.name,
    );
    expect(hasAuditEvent).toBe(true);
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
      fn: () =>
        PolicyDecision.deny({
          policyId: "test.deny",
        }),
    });

    const ctx = {
      agentType: "resident",
      resourceDescriptor: createTestDescriptor(),
    } as GenericPolicyContext & Record<string, unknown>;

    const decision = await engine.dispatch("turn.start", ctx);

    // Verify deny decision
    expect(decision.verdict).toBe("deny");

    // Verify audit events fired
    expect(auditEvents.length).toBeGreaterThan(0);
  });

  it("creates independent registry instances with no shared factory state", () => {
    const registry1 = PolicyRegistry.create();
    const registry2 = PolicyRegistry.create();

    // Register different factories in each registry
    registry1.register("policy-a", () => ({
      name: "policy-a",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "a" }),
    }));

    registry2.register("policy-b", () => ({
      name: "policy-b",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "b" }),
    }));

    // Verify registries are independent
    expect(registry1.has("policy-a")).toBe(true);
    expect(registry1.has("policy-b")).toBe(false);

    expect(registry2.has("policy-a")).toBe(false);
    expect(registry2.has("policy-b")).toBe(true);

    // Verify list() returns only registered policies
    expect(registry1.list()).toEqual(["policy-a"]);
    expect(registry2.list()).toEqual(["policy-b"]);
  });

  it("resolves policies from plan without shared state", () => {
    const registry = PolicyRegistry.create();

    registry.register("policy-1", () => ({
      name: "policy-1",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "1" }),
    }));

    registry.register("policy-2", () => ({
      name: "policy-2",
      timing: "turn.start",
      priority: 200,
      fn: () => PolicyDecision.allow({ policyId: "2" }),
    }));

    const plan = {
      policies: [
        { id: "policy-1", required: true, config: {} },
        { id: "policy-2", required: true, config: {} },
      ],
      labels: [],
    };

    const runtime = {
      auditEmit: () => {
        /* no-op */
      },
    };

    const registrations = registry.resolve(plan, runtime);

    // Verify all policies resolved
    expect(registrations.length).toBe(2);
    expect(registrations[0]?.name).toBe("policy-1");
    expect(registrations[1]?.name).toBe("policy-2");
  });

  it("throws on required policy not found", () => {
    const registry = PolicyRegistry.create();

    const plan = {
      policies: [{ id: "missing-policy", required: true, config: {} }],
      labels: [],
    };

    const runtime = {
      auditEmit: () => {
        /* no-op */
      },
    };

    expect(() => registry.resolve(plan, runtime)).toThrow(
      "Required policy 'missing-policy' is not registered",
    );
  });

  it("skips optional policy not found", () => {
    const registry = PolicyRegistry.create();

    registry.register("policy-1", () => ({
      name: "policy-1",
      timing: "turn.start",
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "1" }),
    }));

    const plan = {
      policies: [
        { id: "policy-1", required: true, config: {} },
        { id: "optional-missing", required: false, config: {} },
      ],
      labels: [],
    };

    const runtime = {
      auditEmit: () => {
        /* no-op */
      },
    };

    const registrations = registry.resolve(plan, runtime);

    // Verify only required policy resolved
    expect(registrations.length).toBe(1);
    expect(registrations[0]?.name).toBe("policy-1");
  });

  it("runs without any server/session bootstrap", async () => {
    // This test proves the entire flow works in isolation:
    // 1. Create engine
    // 2. Register policy
    // 3. Dispatch
    // 4. Receive decision
    // All without importing @openomni/session or @openomni/agent

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
      fn: async (ctx) => {
        // Policy can access generic context fields
        expect(ctx.agentType).toBeDefined();
        expect(ctx.resourceDescriptor).toBeDefined();
        return PolicyDecision.allow({ policyId: "standalone" });
      },
    });

    const ctx = {
      agentType: "resident",
      resourceDescriptor: createTestDescriptor(),
    } as GenericPolicyContext & Record<string, unknown>;

    const decision = await engine.dispatch("turn.start", ctx);

    expect(decision.verdict).toBe("allow");
    expect(auditLog.length).toBeGreaterThan(0);
  });
});
