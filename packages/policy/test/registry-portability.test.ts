import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyRegistry } from "@openomni/policy";

describe("PolicyRegistry portability", () => {
  it("creates independent registry instances with no shared factory state", () => {
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

    expect(registry1.has("policy-a")).toBe(true);
    expect(registry1.has("policy-b")).toBe(false);
    expect(registry2.has("policy-a")).toBe(false);
    expect(registry2.has("policy-b")).toBe(true);
    expect(registry1.list()).toEqual(["policy-a"]);
    expect(registry2.list()).toEqual(["policy-b"]);
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
});
