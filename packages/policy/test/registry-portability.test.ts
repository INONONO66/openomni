import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyRegistry } from "@openomni/policy";

describe("PolicyRegistry portability", () => {
  it("creates independent registry instances with no shared factory state", () => {
    // Isolation is observed through resolve() — the registry's one production
    // read path. The former has()/list() probes were deleted in the #606
    // re-audit: they had no reader outside this test.
    const registry1 = PolicyRegistry.create();
    const registry2 = PolicyRegistry.create();

    registry1.register("policy-a", () => ({
      kind: "point",
      name: "policy-a",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "a" }),
    }));

    registry2.register("policy-b", () => ({
      kind: "point",
      name: "policy-b",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "b" }),
    }));

    const planFor = (id: string) => ({
      policies: [{ id, required: true, config: {} }],
      labels: [],
    });

    expect(registry1.resolve(planFor("policy-a"), {}).map((r) => r.name)).toEqual(["policy-a"]);
    expect(registry2.resolve(planFor("policy-b"), {}).map((r) => r.name)).toEqual(["policy-b"]);
    expect(() => registry1.resolve(planFor("policy-b"), {})).toThrow(
      "Required policy 'policy-b' is not registered",
    );
    expect(() => registry2.resolve(planFor("policy-a"), {})).toThrow(
      "Required policy 'policy-a' is not registered",
    );
  });

  it("resolves policies from plan without shared state", () => {
    const registry = PolicyRegistry.create();

    registry.register("policy-1", () => ({
      kind: "point",
      name: "policy-1",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "1" }),
    }));

    registry.register("policy-2", () => ({
      kind: "point",
      name: "policy-2",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 200,
      fn: () => PolicyDecision.allow({ policyId: "2" }),
    }));

    const registrations = registry.resolve(
      {
        policies: [
          { id: "policy-1", required: true, config: {} },
          { id: "policy-2", required: true, config: {} },
        ],
        labels: [],
      },
      {},
    );

    expect(registrations.length).toBe(2);
    expect(registrations[0]?.name).toBe("policy-1");
    expect(registrations[1]?.name).toBe("policy-2");
  });

  it("throws on required policy not found", () => {
    const registry = PolicyRegistry.create();

    expect(() =>
      registry.resolve(
        {
          policies: [{ id: "missing-policy", required: true, config: {} }],
          labels: [],
        },
        {},
      ),
    ).toThrow("Required policy 'missing-policy' is not registered");
  });

  it("skips optional policy not found", () => {
    const registry = PolicyRegistry.create();

    registry.register("policy-1", () => ({
      kind: "point",
      name: "policy-1",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "1" }),
    }));

    const registrations = registry.resolve(
      {
        policies: [
          { id: "policy-1", required: true, config: {} },
          { id: "optional-missing", required: false, config: {} },
        ],
        labels: [],
      },
      {},
    );

    expect(registrations.length).toBe(1);
    expect(registrations[0]?.name).toBe("policy-1");
  });

  it("records the skipped optional policy under the caller's trace, and stays silent without one", () => {
    // Moved here from agent's registry suite when defaultRegistry died (#642):
    // this package owns resolve(), so it owns the pin. Two decisions live in
    // publishOptionalPolicyMissing — the record itself, and the deliberate
    // no-trace-no-record gate (a minted traceId correlates to nothing).
    const registry = PolicyRegistry.create();
    const emitted: unknown[] = [];

    registry.resolve(
      { policies: [{ id: "optional-missing", required: false, config: {} }], labels: [] },
      {
        traceId: "trace-optional-missing",
        sessionId: "ses-optional-missing",
        auditEmit: (_event, payload) => {
          emitted.push(payload);
        },
      },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      traceId: "trace-optional-missing",
      sessionId: "ses-optional-missing",
      component: "agent.policy.registry",
      msg: "optional policy missing",
      context: { policyId: "optional-missing" },
    });

    const silent: unknown[] = [];
    registry.resolve(
      { policies: [{ id: "optional-missing", required: false, config: {} }], labels: [] },
      {
        auditEmit: (_event, payload) => {
          silent.push(payload);
        },
      },
    );
    expect(silent).toHaveLength(0);
  });

  it("hands each factory the plan config and the resolve runtime", () => {
    // The factory contract: factory(config, runtime). Pinned by
    // building the registration name from both.
    const registry = PolicyRegistry.create();
    registry.register("contract-policy", (config, runtime) => ({
      kind: "point",
      name: `contract:${runtime.agentName}:${(config as { mode: string }).mode}`,
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "contract" }),
    }));

    const registrations = registry.resolve(
      {
        policies: [{ id: "contract-policy", required: true, config: { mode: "strict" } }],
        labels: [],
      },
      { agentName: "primary" },
    );

    expect(registrations.map((registration) => registration.name)).toEqual([
      "contract:primary:strict",
    ]);
  });
});
