import { describe, expect, test } from "bun:test";
import { Policy, PolicyDecision } from "@openomni/protocol";
import {
  PolicyEngine,
  PolicyRegistrationError,
  type PolicyPointId,
  type GenericPolicyContext,
  type CanonicalPolicyRegistrationGeneric,
} from "@openomni/policy";
import { createPolicyRegistrationStore } from "../src/engine/registration";

const allow = () => PolicyDecision.allow({ policyId: "canonical.test" });
const registrationDefaults = { kind: "point", priority: 100, fn: allow } as const;

function expectRegistrationError(
  engine: ReturnType<typeof PolicyEngine.create>,
  registration: Readonly<Record<string, unknown>>,
): PolicyRegistrationError {
  try {
    Reflect.apply(engine.register, engine, [registration]);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyRegistrationError);
    if (error instanceof PolicyRegistrationError) return error;
    throw error;
  }
  throw new Error("Expected PolicyRegistrationError");
}

describe("PolicyEngine canonical registration", () => {
  test("accepts explicit effect-free and multi-point capabilities", () => {
    const engine = PolicyEngine.create({ clock: Date.now });

    expect(() =>
      engine.register({
        ...registrationDefaults,
        name: "effect-free",
        pointIds: ["delegation.worker.post"],
        effectCapabilities: { "delegation.worker.post": [] },
      }),
    ).not.toThrow();
    expect(() =>
      engine.register({
        ...registrationDefaults,
        name: "multi-point",
        pointIds: ["tool.native.pre", "tool.mcp.pre"],
        effectCapabilities: {
          "tool.native.pre": ["tool.rewrite_input", "run.abort"],
          "tool.mcp.pre": ["tool.rewrite_input", "run.abort"],
        },
      }),
    ).not.toThrow();
  });

  test("exposes no legacy timing dispatch entry point around canonical registrations", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    let invocationCount = 0;

    engine.register({
      ...registrationDefaults,
      name: "canonical-deny",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["run.abort"] },
      fn: () => {
        invocationCount++;
        return PolicyDecision.deny({ policyId: "canonical.deny" });
      },
    });

    // The legacy dispatch(timing) member was deleted in #530, so the legacy
    // bypass this test previously pinned is structurally impossible.
    expect(Reflect.get(engine, "dispatch")).toBeUndefined();
    const decision = await engine.dispatchPoint("run.turn.pre", {
      sessionId: "session-1",
      runId: "run-1",
      turnIndex: 0,
    });

    expect(decision.verdict).toBe("deny");
    expect(invocationCount).toBe(1);
  });

  test("snapshots canonical capability declarations at registration", () => {
    const store = createPolicyRegistrationStore();
    const pointIds: PolicyPointId[] = ["run.lifecycle.post"];
    const effects: Policy.PolicyEffectType[] = ["audit.annotate"];
    const effectCapabilities = { "run.lifecycle.post": effects };

    store.register({
      ...registrationDefaults,
      name: "snapshot",
      pointIds,
      effectCapabilities,
    });

    pointIds.splice(0, 1, "run.error.error");
    effects.push("run.abort");
    effectCapabilities["run.lifecycle.post"] = ["run.abort"];
    const stored = store.selectPoint("run.lifecycle.post");

    expect(stored).toHaveLength(1);
    expect(stored[0]?.pointIds).toEqual(["run.lifecycle.post"]);
    expect(stored[0]?.effectCapabilities["run.lifecycle.post"]).toEqual(["audit.annotate"]);
  });

  test("snapshots canonical scope declarations at registration", () => {
    const store = createPolicyRegistrationStore();
    const agentTypes = ["resident"];

    store.register({
      ...registrationDefaults,
      name: "scoped-snapshot",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      scope: { agentType: agentTypes },
    });

    agentTypes.splice(0, 1, "worker");

    expect(store.selectPoint("run.lifecycle.post", "resident")).toHaveLength(1);
    expect(store.selectPoint("run.lifecycle.post", "worker")).toHaveLength(0);
  });

  test("deeply protects selected canonical snapshots from caller mutation", () => {
    const store = createPolicyRegistrationStore();
    store.register({
      ...registrationDefaults,
      name: "protected-snapshot",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      scope: { agentType: ["resident"] },
    });

    const selected = store.selectPoint("run.lifecycle.post", "resident")[0];
    if (!selected) throw new Error("Missing canonical snapshot");
    const effects = selected.effectCapabilities["run.lifecycle.post"] ?? [];
    const scope = selected.scope;
    const agentTypes = scope?.agentType ?? [];
    const mutations = [
      Reflect.set(selected, "priority", 0),
      Reflect.set(selected, "pointIds", ["run.error.error"]),
      Reflect.set(selected.pointIds, 0, "run.error.error"),
      Reflect.set(selected.effectCapabilities, "run.lifecycle.post", ["run.abort"]),
      Reflect.set(effects, 0, "run.abort"),
      Reflect.set(scope ?? {}, "agentType", ["worker"]),
      Reflect.set(agentTypes, 0, "worker"),
    ];

    expect(mutations).toEqual(Array.from({ length: mutations.length }, () => false));
    expect(store.selectPoint("run.lifecycle.post", "resident")).toHaveLength(1);
    expect(store.selectPoint("run.lifecycle.post", "worker")).toHaveLength(0);
    expect(store.selectPoint("run.error.error", "resident")).toHaveLength(0);
    expect(selected.pointIds).toEqual(["run.lifecycle.post"]);
    expect(selected.effectCapabilities["run.lifecycle.post"]).toEqual(["audit.annotate"]);
  });

  test("rejects non-point kind and malformed canonical boundaries with typed errors", () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    const base = { ...registrationDefaults, name: "malformed" };

    expectRegistrationError(engine, {
      ...registrationDefaults,
      name: "invalid-kind",
      kind: "legacy",
      timing: "turn.start",
    });
    const missingKind = expectRegistrationError(engine, {
      name: "missing-kind",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      priority: registrationDefaults.priority,
      fn: registrationDefaults.fn,
    });
    expect(missingKind.code).toBe("invalid_canonical_registration");
    expectRegistrationError(engine, {
      ...base,
      effectCapabilities: { "run.lifecycle.post": [] },
    });
    expectRegistrationError(engine, {
      ...base,
      pointIds: ["run.lifecycle.post"],
    });
  });

  test("rejects an empty scope agentType array with a typed error", () => {
    // scope: { agentType: [] } is the config-filter footgun: it used to mean
    // "unscoped" and silently applied the policy to every agent. Fail-closed
    // at the boundary — unscoped is spelled by omitting agentType.
    const engine = PolicyEngine.create({ clock: Date.now });

    const error = expectRegistrationError(engine, {
      ...registrationDefaults,
      name: "empty-scope",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      scope: { agentType: [] },
    });

    expect(error.code).toBe("empty_scope_agent_type");
    expect(error.registrationName).toBe("empty-scope");
  });

  test("rejects empty and duplicate point bindings with typed errors", () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    const base = {
      ...registrationDefaults,
      name: "invalid-points",
      effectCapabilities: { "run.lifecycle.post": [] },
    };

    expectRegistrationError(engine, { ...base, pointIds: [] });
    expectRegistrationError(engine, {
      ...base,
      pointIds: ["run.lifecycle.post", "run.lifecycle.post"],
    });
  });

  test("rejects empty, missing, unknown, and unbound capability entries with typed errors", () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    const base = {
      ...registrationDefaults,
      name: "invalid-capabilities",
      pointIds: ["run.lifecycle.post"],
    };

    expectRegistrationError(engine, { ...base, effectCapabilities: {} });
    expectRegistrationError(engine, {
      ...base,
      pointIds: ["run.lifecycle.post", "delegation.worker.post"],
      effectCapabilities: { "run.lifecycle.post": [] },
    });
    expectRegistrationError(engine, {
      ...base,
      pointIds: ["unknown.point.pre"],
      effectCapabilities: { "unknown.point.pre": [] },
    });
    expectRegistrationError(engine, {
      ...base,
      effectCapabilities: {
        "run.lifecycle.post": [],
        "delegation.worker.post": [],
      },
    });
  });

  test("rejects effects outside a point contract's allowed maximum", () => {
    const engine = PolicyEngine.create({ clock: Date.now });

    expectRegistrationError(engine, {
      ...registrationDefaults,
      name: "disallowed-effect",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["run.abort"] },
    });
  });

  test("rejects duplicate effects with a typed error", () => {
    const engine = PolicyEngine.create({ clock: Date.now });

    expectRegistrationError(engine, {
      ...registrationDefaults,
      name: "duplicate-effect",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate", "audit.annotate"] },
    });
  });

  test("rejects disallowed effects after attempted catalog mutation", () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    const allowedEffects = Policy.PolicyPoint.Registry["run.lifecycle.post"].allowedEffects;
    const mutated = Reflect.set(allowedEffects, allowedEffects.length, "run.abort");

    try {
      expect(mutated).toBe(false);
      expect(() =>
        engine.register({
          ...registrationDefaults,
          name: "mutated-authority",
          pointIds: ["run.lifecycle.post"],
          effectCapabilities: { "run.lifecycle.post": ["run.abort"] },
        }),
      ).toThrow(PolicyRegistrationError);
    } finally {
      if (mutated) {
        Reflect.apply(Array.prototype.splice, allowedEffects, [allowedEffects.length - 1, 1]);
      }
    }
  });
});

test("accepts union-typed registrations through the public engine overload", () => {
  const engine = PolicyEngine.create<GenericPolicyContext>({ clock: Date.now });
  const registerUnion = (registration: CanonicalPolicyRegistrationGeneric<GenericPolicyContext>) =>
    engine.register(registration);

  expect(() =>
    registerUnion({
      kind: "point",
      name: "union-registration",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "union-registration" }),
    }),
  ).not.toThrow();
});
