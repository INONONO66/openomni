import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { createPolicyEngine } from "../src/engine/dispatch";
import { PolicyRegistrationError } from "../src/engine/registration";
import { turnPreContext } from "./point-test-fixtures";

function factory() {
  let instances = 0;
  return {
    kind: "factory" as const,
    name: "stateful",
    create() {
      instances += 1;
      let fired = false;
      return {
        kind: "point" as const,
        name: "stateful",
        pointIds: ["run.turn.pre" as const],
        effectCapabilities: { "run.turn.pre": ["audit.annotate" as const] },
        priority: 0,
        fn: () => {
          if (fired) return PolicyDecision.allow({ policyId: "stateful" });
          fired = true;
          return PolicyDecision.allow({
            policyId: "stateful",
            effects: [{ type: "audit.annotate" as const, annotation: "first", severity: "info" as const }],
          });
        },
      };
    },
    instances: () => instances,
  };
}

describe("policy registration factories", () => {
  it("creates independent state for each engine", async () => {
    const shared = factory();
    const firstEngine = createPolicyEngine({ clock: Date.now });
    const secondEngine = createPolicyEngine({ clock: Date.now });
    firstEngine.add(shared);
    secondEngine.add(shared);

    const first = await firstEngine.dispatchPoint("run.turn.pre", turnPreContext());
    const fresh = await secondEngine.dispatchPoint("run.turn.pre", turnPreContext());
    const repeated = await firstEngine.dispatchPoint("run.turn.pre", turnPreContext());

    expect(shared.instances()).toBe(2);
    expect(first.effects).toHaveLength(1);
    expect(fresh.effects).toHaveLength(1);
    expect(repeated.effects).toEqual([]);
  });

  it("rejects factories without a callable creator", () => {
    const engine = createPolicyEngine({ clock: Date.now });

    expect(() => Reflect.apply(engine.add, engine, [{ kind: "factory", name: "bad", create: 1 }])).toThrow(
      PolicyRegistrationError,
    );
  });

  it("rejects factories that do not produce point registrations", () => {
    const engine = createPolicyEngine({ clock: Date.now });

    expect(() => Reflect.apply(engine.add, engine, [{ kind: "factory", name: "null", create: () => null }])).toThrow(
      PolicyRegistrationError,
    );
    expect(() =>
      Reflect.apply(engine.add, engine, [
        { kind: "factory", name: "nested", create: () => ({ kind: "factory", name: "nested" }) },
      ]),
    ).toThrow(PolicyRegistrationError);
  });

  it("rejects asynchronous direct callbacks before dispatch", () => {
    const engine = createPolicyEngine({ clock: Date.now });

    expect(() =>
      Reflect.apply(engine.add, engine, [{
        kind: "point",
        name: "async",
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        priority: 0,
        fn: async () => PolicyDecision.allow({ policyId: "async" }),
      }]),
    ).toThrow(PolicyRegistrationError);
  });

  it("audits middleware failures under the dispatch trace", async () => {
    const events: Array<{ readonly name: string; readonly data: object }> = [];
    let now = 10;
    const engine = createPolicyEngine({
      clock: () => now++,
      traceContext: { traceId: "engine-trace", sessionId: "session-1" },
      auditEmit: (event, data) => {
        if (typeof data === "object" && data !== null) events.push({ name: event.name, data });
      },
    });
    engine.add({
      kind: "point",
      name: "throwing",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 0,
      failPolicy: "fail-open",
      fn: () => {
        throw new Error("failed");
      },
    });

    const decision = await engine.dispatchPoint("run.turn.pre", {
      ...turnPreContext(),
      traceContext: { traceId: "dispatch-trace", sessionId: "session-1" },
    });

    expect(decision.verdict).toBe("allow");
    expect(events.find((event) => event.name === Operational.Events.Warn.name)?.data).toMatchObject({
      traceId: "dispatch-trace",
      context: { name: "throwing", failPolicy: "fail-open" },
    });
  });
});
