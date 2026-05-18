import { describe, expect, it } from "bun:test";
import { Operational, type Policy } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { PolicyRegistry, defaultRegistry } from "../../../src/core/policy";
import type { PolicyFactory } from "../../../src/core/policy";
import { allow } from "../../helpers/policy-decision";

const builtinPolicyIds = [
  "builtin:budget-reassurance",
  "builtin:budget-warning",
  "builtin:compaction",
  "builtin:idle-nudge",
  "builtin:tool-permission",
];

function plan(policies: Policy.PolicyPlan["policies"]): Policy.PolicyPlan {
  return { policies, labels: [] };
}

describe("PolicyRegistry", () => {
  it("defaultRegistry() has all builtins registered", () => {
    const registry = defaultRegistry();

    expect(registry.list()).toEqual(builtinPolicyIds);
    for (const id of builtinPolicyIds) {
      expect(registry.has(id)).toBe(true);
    }
  });

  it("resolve() with a valid plan returns policy registrations", () => {
    const registry = PolicyRegistry.create();
    const factory: PolicyFactory = (config, runtime) => ({
      name: `test:${runtime.agentName}:${(config as { mode: string }).mode}`,
      timing: "turn.start",
      priority: 10,
      fn: () => allow(),
    });
    registry.register("test.policy", factory);

    const registrations = registry.resolve(
      plan([{ id: "test.policy", required: true, config: { mode: "strict" } }]),
      { agentName: "primary" },
    );

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.name).toBe("test:primary:strict");
  });

  it("resolve() with a missing required policy throws", () => {
    const registry = PolicyRegistry.create();

    expect(() => registry.resolve(plan([{ id: "missing.policy", required: true }]), {})).toThrow(
      "Required policy 'missing.policy' is not registered",
    );
  });

  it("resolve() with a missing optional policy skips it and logs", async () => {
    Bus.reset();
    const events: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === Operational.Warn.name) events.push(payload);
    });

    try {
      const registry = PolicyRegistry.create();
      registry.register("present.policy", () => ({
        name: "present.policy",
        timing: "turn.start",
        priority: 10,
        fn: () => allow(),
      }));

      const registrations = registry.resolve(
        plan([
          { id: "missing.optional", required: false },
          { id: "present.policy", required: true },
        ]),
        { sessionId: "session-1", runId: "run-1", agentName: "primary" },
      );
      await Promise.resolve();

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.name).toBe("present.policy");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        traceId: "run-1",
        sessionId: "session-1",
        component: "agent.policy.registry",
        msg: "optional policy missing",
        context: { policyId: "missing.optional", agentName: "primary" },
      });
    } finally {
      unsubscribe();
      Bus.reset();
    }
  });
});
