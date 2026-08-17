import { describe, expect, test } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEngine, PolicyRegistrationError } from "@openomni/policy";
import type { PolicyRegistrationFactoryGeneric, GenericPolicyContext } from "@openomni/policy";
import { dispatchContext } from "./point-test-fixtures";

/**
 * Audit H1: stateful policies must not share closure state across engines.
 * One engine is built per agent run, so a `kind: "factory"` registration —
 * instantiated at the registration boundary, once per engine — is what makes
 * per-run state per-run even when the same middleware array is reused across
 * sequential runs and across parent/child agents.
 */
describe("per-engine registration factories", () => {
  function onceFactory(): PolicyRegistrationFactoryGeneric<GenericPolicyContext> & {
    instances: () => number;
  } {
    let instances = 0;
    return {
      kind: "factory",
      name: "test:once",
      create: () => {
        instances += 1;
        let fired = false;
        return {
          kind: "point",
          name: "test:once",
          pointIds: ["dispatch.action.pre"],
          effectCapabilities: { "dispatch.action.pre": ["audit.annotate"] },
          priority: 100,
          fn: () => {
            if (fired) return PolicyDecision.allow({ policyId: "test.once" });
            fired = true;
            return PolicyDecision.allow({
              policyId: "test.once",
              effects: [{ type: "audit.annotate", annotation: "first", severity: "info" }],
            });
          },
        };
      },
      instances: () => instances,
    };
  }

  test("each engine registering the same factory gets independent state", async () => {
    const shared = onceFactory();
    const engineOne = PolicyEngine.create();
    const engineTwo = PolicyEngine.create();
    engineOne.register(shared);
    engineTwo.register(shared);
    expect(shared.instances()).toBe(2);

    const first = await engineOne.dispatchPoint("dispatch.action.pre", { ...dispatchContext });
    // Engine two's policy has NOT fired yet: engine one's dispatch must not
    // have consumed its once-latch.
    const fresh = await engineTwo.dispatchPoint("dispatch.action.pre", { ...dispatchContext });
    const second = await engineOne.dispatchPoint("dispatch.action.pre", { ...dispatchContext });

    expect(first.effects).toHaveLength(1);
    expect(fresh.effects).toHaveLength(1);
    expect(second.effects).toHaveLength(0);
  });

  test("a factory whose create is not a function is rejected fail-closed", () => {
    const engine = PolicyEngine.create();
    expect(() =>
      Reflect.apply(engine.register, engine, [{ kind: "factory", name: "test:bad", create: 1 }]),
    ).toThrow(PolicyRegistrationError);
  });

  test("a factory producing a non-registration is rejected fail-closed", () => {
    const engine = PolicyEngine.create();
    expect(() =>
      Reflect.apply(engine.register, engine, [
        { kind: "factory", name: "test:bad-product", create: () => null },
      ]),
    ).toThrow(PolicyRegistrationError);
    expect(() =>
      Reflect.apply(engine.register, engine, [
        // Factory-of-factory is refused: the product must be a canonical
        // point registration.
        {
          kind: "factory",
          name: "test:nested",
          create: () => ({ kind: "factory", name: "test:nested", create: () => null }),
        },
      ]),
    ).toThrow(PolicyRegistrationError);
  });
});
