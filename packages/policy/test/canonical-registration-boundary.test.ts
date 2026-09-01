import { describe, expect, test } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEngine, PolicyRegistrationError } from "@openomni/policy";
import { createPolicyRegistrationStore } from "../src/engine/registration";
import { dispatchContext } from "./point-test-fixtures";

const allow = () => PolicyDecision.allow({ policyId: "canonical.boundary.test" });

function registrationErrorFor(
  registration: Readonly<Record<string, unknown>>,
): PolicyRegistrationError {
  const engine = PolicyEngine.create({ clock: Date.now });
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
    const engine = PolicyEngine.create({ clock: Date.now });

    expect(() =>
      engine.register({
        kind: "point",
        name: "complete-canonical",
        pointIds: ["run.lifecycle.post"],
        effectCapabilities: { "run.lifecycle.post": ["audit.annotate"] },
        priority: 0,
        scope: { agentType: ["resident"] },
        failPolicy: "fail-closed",
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
      { priority: Number.NaN },
      { priority: Number.NEGATIVE_INFINITY },
      { fn: "not-a-function" },
      { scope: "resident" },
      { scope: { agentType: "resident" } },
      { scope: { agentType: ["resident", 1] } },
      { failPolicy: "ignore" },
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
  });
});

test("rejects a legacy-shaped proxy fail-closed without reclassifying its later canonical view", async () => {
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
  const engine = PolicyEngine.create({ clock: Date.now });

  let rejection: unknown;
  try {
    Reflect.apply(engine.register, engine, [registration]);
  } catch (error) {
    rejection = error;
  }
  exposeCanonical = true;
  const decision = await engine.dispatchPoint("dispatch.action.pre", dispatchContext);

  // Fail-closed since #530: the legacy-shaped view is rejected at the
  // boundary from a single classification read, so the later canonical proxy
  // view never registers or dispatches.
  expect(rejection).toBeInstanceOf(PolicyRegistrationError);
  expect((rejection as PolicyRegistrationError).code).toBe("legacy_timing_registration");
  expect(decision.verdict).toBe("allow");
  expect(canonicalInvocations).toBe(0);
  expect(hasProbes).toBe(0);
  for (const field of ["kind", "name", "pointIds", "effectCapabilities"]) {
    expect(reads[field]).toBe(1);
  }
  for (const field of ["timing", "priority", "scope", "failPolicy", "fn"]) {
    expect(reads[field]).toBeUndefined();
  }
});

test("rejects legacy timing snapshot registrations fail-closed without storing them", () => {
  const store = createPolicyRegistrationStore();
  const registration = {
    name: "legacy-snapshot",
    timing: ["turn.start"],
    priority: 10,
    scope: { agentType: ["resident"] },
    failPolicy: "fail-open",
    fn: () => PolicyDecision.allow({ policyId: "legacy-snapshot" }),
  };

  let rejection: unknown;
  try {
    Reflect.apply(store.register, store, [registration]);
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toBeInstanceOf(PolicyRegistrationError);
  expect((rejection as PolicyRegistrationError).code).toBe("legacy_timing_registration");
  expect((rejection as PolicyRegistrationError).registrationName).toBe("legacy-snapshot");
  // "turn.start" maps to run.turn.pre; nothing may be stored for it.
  expect(store.selectPoint("run.turn.pre", "resident")).toHaveLength(0);
});

test("rejects non-object registrations at the public boundary", () => {
  const engine = PolicyEngine.create({ clock: Date.now });
  for (const registration of [null, [], "policy"]) {
    try {
      Reflect.apply(engine.register, engine, [registration]);
      throw new Error("expected registration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyRegistrationError);
      expect((error as PolicyRegistrationError).code).toBe("invalid_canonical_registration");
    }
  }
});

test("rejects unreadable and non-string capability arrays", () => {
  const unreadable = new Proxy(["audit.annotate"], {
    get(target, property, receiver) {
      if (property === "0") throw new Error("unreadable capability");
      return Reflect.get(target, property, receiver);
    },
  });
  for (const capabilities of [unreadable, [1]]) {
    const error = registrationErrorFor({
      kind: "point",
      name: "invalid-capability-array",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": capabilities },
      priority: 0,
      fn: allow,
    });
    expect(error.code).toBe("invalid_canonical_registration");
    expect(error.pointId).toBe("run.lifecycle.post");
  }
});

test("reports the rejected effect capability as structured error data", () => {
  const error = registrationErrorFor({
    kind: "point",
    name: "unknown-effect",
    pointIds: ["run.lifecycle.post"],
    effectCapabilities: { "run.lifecycle.post": ["not.an.effect"] },
    priority: 0,
    fn: allow,
  });

  expect(error.code).toBe("disallowed_effect_capability");
  expect(error.pointId).toBe("run.lifecycle.post");
  expect(error.effectType).toBe("not.an.effect");
});

test("rejects canonical point arrays with unsafe proxy lengths", () => {
  const pointIds = new Proxy(["run.lifecycle.post"], {
    get(target, property, receiver) {
      if (property === "length") return Number.MAX_SAFE_INTEGER + 1;
      return Reflect.get(target, property, receiver);
    },
  });

  expect(
    registrationErrorFor({
      kind: "point",
      name: "unsafe-point-array",
      pointIds,
      effectCapabilities: { "run.lifecycle.post": [] },
      priority: 0,
      fn: allow,
    }).code,
  ).toBe("invalid_canonical_registration");
});

test("rejects enumerable __proto__ effect capability keys", () => {
  const effectCapabilities = Object.create(null) as Record<string, unknown>;
  effectCapabilities["run.lifecycle.post"] = [];
  Object.defineProperty(effectCapabilities, "__proto__", {
    enumerable: true,
    value: [],
  });

  expect(
    registrationErrorFor({
      kind: "point",
      name: "proto-capability",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities,
      priority: 0,
      fn: allow,
    }).code,
  ).toBe("unknown_point_id");
});

test("rejects the #578-retired ingress points as unknown", () => {
  for (const retired of ["session.inbound.pre", "session.writeback.pre"]) {
    const error = registrationErrorFor({
      kind: "point",
      name: "retired-578",
      pointIds: [retired],
      effectCapabilities: { [retired]: [] },
      priority: 0,
      fn: allow,
    });
    expect(error.code).toBe("unknown_point_id");
    expect(error.pointId).toBe(retired);
  }
});
