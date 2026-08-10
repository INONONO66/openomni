import { expect, test } from "bun:test";
import { type Policy, PolicyDecision } from "@openomni/protocol";
import { createPolicyRegistrationStore, PolicyRegistrationError } from "../src/engine/registration";

interface ReadCounts {
  length: number;
  element: number;
}

function changingArray<T>(first: T, changed: T, reads: ReadCounts): T[] {
  return new Proxy([first], {
    get: (target, property, receiver) => {
      if (property === "length") reads.length += 1;
      if (property === "0") {
        reads.element += 1;
        return reads.element === 1 ? first : changed;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test("captures canonical nested arrays once before validation", () => {
  const pointReads: ReadCounts = { length: 0, element: 0 };
  const effectReads: ReadCounts = { length: 0, element: 0 };
  const scopeReads: ReadCounts = { length: 0, element: 0 };
  const pointIds = changingArray(
    "run.lifecycle.post" as const,
    "run.error.error" as const,
    pointReads,
  );
  const effects = changingArray<Policy.PolicyEffectType>(
    "audit.annotate",
    "run.abort",
    effectReads,
  );
  const agentTypes = changingArray("resident", "worker", scopeReads);
  const store = createPolicyRegistrationStore();

  store.register({
    kind: "point",
    name: "nested-canonical-snapshot",
    pointIds,
    effectCapabilities: { "run.lifecycle.post": effects },
    priority: 0,
    scope: { agentType: agentTypes },
    fn: () => PolicyDecision.allow({ policyId: "nested-canonical-snapshot" }),
  });
  const [stored] = store.selectPoint("run.lifecycle.post", "resident");

  expect(stored?.pointIds).toEqual(["run.lifecycle.post"]);
  expect(stored?.effectCapabilities).toEqual({ "run.lifecycle.post": ["audit.annotate"] });
  expect(stored?.scope?.agentType).toEqual(["resident"]);
  expect(pointReads).toEqual({ length: 1, element: 1 });
  expect(effectReads).toEqual({ length: 1, element: 1 });
  expect(scopeReads).toEqual({ length: 1, element: 1 });
});

test("rejects legacy timing registrations fail-closed before capturing scope", () => {
  const scopeReads: ReadCounts = { length: 0, element: 0 };
  const agentTypes = changingArray("resident", "worker", scopeReads);
  const store = createPolicyRegistrationStore();

  let rejection: unknown;
  try {
    Reflect.apply(store.register, store, [
      {
        name: "nested-legacy-snapshot",
        timing: "turn.start",
        priority: Number.NaN,
        scope: { agentType: agentTypes },
        fn: () => PolicyDecision.allow({ policyId: "nested-legacy-snapshot" }),
      },
    ]);
  } catch (error) {
    rejection = error;
  }

  // Fail-closed since #530: legacy shapes are rejected from classification
  // fields alone; caller-owned scope arrays are never read.
  expect(rejection).toBeInstanceOf(PolicyRegistrationError);
  expect((rejection as PolicyRegistrationError).code).toBe("legacy_timing_registration");
  expect(store.selectPoint("run.turn.pre", "resident")).toHaveLength(0);
  expect(scopeReads).toEqual({ length: 0, element: 0 });
});
