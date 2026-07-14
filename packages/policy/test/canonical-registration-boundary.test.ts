import { describe, expect, test } from "bun:test";
import { type Policy, PolicyDecision } from "@openomni/protocol";
import {
  type GenericPolicyContext,
  PolicyEngine,
  type PolicyRegistrationGeneric,
  PolicyRegistrationError,
} from "@openomni/policy";
import { createPolicyRegistrationStore } from "../src/engine/registration";
import { dispatchContext } from "./point-test-fixtures";

const allow = () => PolicyDecision.allow({ policyId: "canonical.boundary.test" });

function registrationErrorFor(
  registration: Readonly<Record<string, unknown>>,
): PolicyRegistrationError {
  const engine = PolicyEngine.create();
  try {
    Reflect.apply(engine.register, engine, [registration]);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyRegistrationError);
    if (error instanceof PolicyRegistrationError) return error;
    throw error;
  }
  throw new Error("Expected PolicyRegistrationError");
}

describe("PolicyEngine canonical registration boundary", () => {
  test("accepts complete canonical metadata", () => {
    const engine = PolicyEngine.create();

    expect(() =>
      engine.register({
        kind: "point",
        name: "complete-canonical",
        pointIds: ["run.lifecycle.post"],
        effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
        priority: 0,
        scope: { agentType: ["resident"] },
        failPolicy: "fail-closed",
        propagate: true,
        fn: allow,
      }),
    ).not.toThrow();
  });

  test("rejects malformed canonical metadata with typed errors", () => {
    const base = {
      kind: "point",
      name: "canonical-boundary",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
      priority: 100,
      fn: allow,
    };
    const malformed = [
      { name: "" },
      { name: 1 },
      { priority: -1 },
      { priority: 1.5 },
      { fn: "not-a-function" },
      { scope: "resident" },
      { scope: { agentType: "resident" } },
      { scope: { agentType: ["resident", 1] } },
      { failPolicy: "ignore" },
      { propagate: "yes" },
    ];

    for (const override of malformed) {
      expect(registrationErrorFor({ ...base, ...override }).code).toBe(
        "invalid_canonical_registration",
      );
    }
  });
});

test("reads each canonical boundary field once and stores the first trusted snapshot", async () => {
  const reads = {
    kind: 0,
    name: 0,
    pointIds: 0,
    effectCapabilities: 0,
    priority: 0,
    scope: 0,
    failPolicy: 0,
    fn: 0,
    propagate: 0,
  };
  const first = <T>(field: keyof typeof reads, trusted: T, changed: T): T =>
    ++reads[field] === 1 ? trusted : changed;

  const registration = {
    get kind() {
      return first("kind", "point", "legacy");
    },
    get name() {
      return first("name", "trusted-name", "changed-name");
    },
    get pointIds() {
      return first("pointIds", ["run.lifecycle.post"], ["run.error.error"]);
    },
    get effectCapabilities() {
      return first(
        "effectCapabilities",
        { "run.lifecycle.post": [] },
        { "run.error.error": ["run.abort"] },
      );
    },
    get priority() {
      return first("priority", 10, 999);
    },
    get scope() {
      return first("scope", { agentType: ["resident"] }, { agentType: ["worker"] });
    },
    get failPolicy() {
      return first("failPolicy", "fail-open", "fail-closed");
    },
    get fn() {
      return first(
        "fn",
        () => PolicyDecision.allow({ policyId: "trusted-policy" }),
        () => PolicyDecision.deny({ policyId: "changed-policy" }),
      );
    },
    get propagate() {
      return first("propagate", false, true);
    },
  };
  const store = createPolicyRegistrationStore();

  Reflect.apply(store.register, store, [registration]);

  const [stored] = store.selectPoint("run.lifecycle.post", "resident");
  expect(stored).toMatchObject({
    kind: "point",
    name: "trusted-name",
    pointIds: ["run.lifecycle.post"],
    effectCapabilities: { "run.lifecycle.post": [] },
    priority: 10,
    scope: { agentType: ["resident"] },
    failPolicy: "fail-open",
    propagate: false,
  });
  expect((await stored?.fn({ pointId: "run.lifecycle.post", timing: "run.finish" }))?.verdict).toBe(
    "allow",
  );
  expect(reads).toEqual({
    kind: 1,
    name: 1,
    pointIds: 1,
    effectCapabilities: 1,
    priority: 1,
    scope: 1,
    failPolicy: 1,
    fn: 1,
    propagate: 1,
  });
});

test("does not reclassify a captured legacy registration when its proxy view changes", async () => {
  let exposeCanonical = false;
  let canonicalInvocations = 0;
  let hasProbes = 0;
  const reads: Record<string, number> = {};
  const registration = new Proxy(
    {},
    {
      has: (_target, property) => {
        hasProbes += 1;
        return (
          exposeCanonical &&
          (property === "kind" || property === "pointIds" || property === "effectCapabilities")
        );
      },
      get: (_target, property) => {
        if (typeof property === "string") reads[property] = (reads[property] ?? 0) + 1;
        if (property === "name") return "classification-flip";
        if (property === "priority") return 0;
        if (property === "timing") return "dispatch.authorize";
        if (property === "kind") return exposeCanonical ? "point" : undefined;
        if (property === "pointIds") return exposeCanonical ? ["dispatch.action.pre"] : undefined;
        if (property === "effectCapabilities") {
          return exposeCanonical ? { "dispatch.action.pre": [] } : undefined;
        }
        if (property === "fn") {
          return () => {
            canonicalInvocations += 1;
            return PolicyDecision.allow({ policyId: "classification-flip" });
          };
        }
        return undefined;
      },
    },
  );
  const engine = PolicyEngine.create();

  Reflect.apply(engine.register, engine, [registration]);
  exposeCanonical = true;
  const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

  expect(decision.verdict).toBe("allow");
  expect(canonicalInvocations).toBe(0);
  expect(hasProbes).toBe(0);
  for (const field of [
    "kind",
    "name",
    "pointIds",
    "effectCapabilities",
    "timing",
    "priority",
    "scope",
    "failPolicy",
    "fn",
    "propagate",
  ]) {
    expect(reads[field]).toBe(1);
  }
});

test("stores a frozen legacy snapshot without retaining caller-owned metadata", () => {
  const store = createPolicyRegistrationStore();
  const timing: Policy.Timing[] = ["turn.start"];
  const agentTypes = ["resident"];
  const originalFn = () => PolicyDecision.allow({ policyId: "legacy-snapshot" });
  const registration: PolicyRegistrationGeneric<GenericPolicyContext> = {
    name: "legacy-snapshot",
    timing,
    priority: 10,
    scope: { agentType: agentTypes },
    failPolicy: "fail-open",
    propagate: true,
    fn: originalFn,
  };

  store.register(registration);
  const stored = store.selectLegacy("turn.start", "resident")[0];
  if (stored === undefined) throw new Error("Missing legacy snapshot");
  registration.name = "changed";
  registration.priority = 0;
  registration.failPolicy = "fail-closed";
  registration.propagate = false;
  registration.fn = () => PolicyDecision.deny({ policyId: "changed" });
  timing.splice(0, 1, "error");
  agentTypes.splice(0, 1, "worker");

  expect(stored).toMatchObject({
    name: "legacy-snapshot",
    timing: ["turn.start"],
    priority: 10,
    failPolicy: "fail-open",
    propagate: true,
  });
  expect(stored.scope?.agentType).toEqual(["resident"]);
  expect(stored.fn).toBe(originalFn);
  expect(Object.isFrozen(stored)).toBe(true);
  expect(Object.isFrozen(stored.timing)).toBe(true);
  expect(Object.isFrozen(stored.scope)).toBe(true);
  expect(Object.isFrozen(stored.scope?.agentType)).toBe(true);
  expect(store.selectLegacy("turn.start", "resident")).toEqual([stored]);
});
