import { describe, expect, it } from "bun:test";
import { Operational, type Policy } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { z } from "zod";
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
    const FactoryConfig = z.object({ mode: z.string() });
    const registry = PolicyRegistry.create();
    const factory: PolicyFactory = (config, runtime) => ({
      name: `test:${runtime.agentName}:${FactoryConfig.parse(config).mode}`,
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

  it("defaultRegistry() resolves typed builtin configs", () => {
    const registrations = defaultRegistry().resolve(
      plan([
        {
          id: "builtin:compaction",
          required: true,
          config: { contextWindowTokens: 1000, thresholdRatio: 0.8 },
        },
        { id: "builtin:idle-nudge", required: true, config: { idleThresholdMs: 1000 } },
        {
          id: "builtin:tool-permission",
          required: true,
          config: { permission: { action: "tool.call", allowlist: ["read_file"] } },
        },
      ]),
      {},
    );

    expect(registrations.map((registration) => registration.name)).toEqual([
      "builtin:compaction",
      "builtin:idle-nudge",
      "builtin:tool-permission",
    ]);
  });

  it("defaultRegistry() resolves configless default builtin policies", () => {
    const registrations = defaultRegistry().resolve(
      plan([
        { id: "builtin:idle-nudge", required: true },
        { id: "builtin:tool-permission", required: true },
      ]),
      {},
    );

    expect(registrations.map((registration) => registration.name)).toEqual([
      "builtin:idle-nudge",
      "builtin:tool-permission",
    ]);
  });

  it("defaultRegistry() rejects malformed builtin configs at resolution", () => {
    expect(() =>
      defaultRegistry().resolve(
        plan([{ id: "builtin:compaction", required: true, config: { thresholdRatio: 0.8 } }]),
        {},
      ),
    ).toThrow();
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
        { sessionId: "session-1", runId: "run-1", agentName: "primary", auditEmit: Bus.publish },
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
