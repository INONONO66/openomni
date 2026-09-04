import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { createPolicyEngine } from "../src/engine/dispatch";
import { createPolicyRegistrationStore, PolicyRegistrationError } from "../src/engine/registration";

const PolicyEngine = { create: createPolicyEngine };

function createDispatchContext() {
  return {
    sessionId: "session-portability",
    runId: "run-portability",
    turnIndex: 0,
    agentType: "resident",
    resourceDescriptor: {
      id: "dispatch:test",
      kind: "dispatch" as const,
      labels: [],
      capabilities: [],
      effects: [],
    },
  };
}

/**
 * An engine that emits audit has to know the trace it is emitting under: the
 * publishers return early rather than mint one, so a `traceContext` is not
 * decoration here — without it there is nothing to observe.
 */
function createAuditedEngine() {
  const events: Array<{ name: string; data: unknown }> = [];
  const engine = PolicyEngine.create({
    clock: Date.now,
    traceContext: { traceId: "trace-portability", sessionId: "session-portability" },
    auditEmit: (event, data) => {
      events.push({ name: event.name, data });
    },
  });
  return { engine, events };
}

function debugEvent(
  events: ReadonlyArray<{ name: string; data: unknown }>,
): { name: string; data: unknown } | undefined {
  return events.find((event) => event.name === Operational.Events.Debug.name);
}

function capturedRegistrationError(register: () => void): PolicyRegistrationError {
  try {
    register();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyRegistrationError);
    if (error instanceof PolicyRegistrationError) return error;
    throw error;
  }
  throw new Error("Expected PolicyRegistrationError");
}

describe("PolicyEngine portability", () => {
  it("does not match a scoped canonical registration when agentType is empty", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    let invocationCount = 0;

    engine.add({
      kind: "point",
      name: "scoped-canonical",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      scope: { agentType: ["resident"] },
      fn: () => {
        invocationCount++;
        return PolicyDecision.deny({ policyId: "scoped.canonical" });
      },
    });

    const decision = await engine.dispatchPoint("run.turn.pre", {
      ...createDispatchContext(),
      agentType: "",
    });

    expect(decision.verdict).toBe("allow");
    expect(invocationCount).toBe(0);
  });

  it("rejects legacy timing registrations fail-closed at the trusted boundary", () => {
    const engine = PolicyEngine.create({ clock: Date.now });

    const error = capturedRegistrationError(() =>
      Reflect.apply(engine.add, engine, [
        {
          name: "legacy-registration",
          timing: "turn.start",
          priority: 100,
          fn: () => PolicyDecision.deny({ policyId: "legacy.registration" }),
        },
      ]),
    );

    expect(error.code).toBe("invalid_canonical_registration");
    expect(error.registrationName).toBe("legacy-registration");
  });

  it("rejects negative canonical priorities at the registration boundary", () => {
    const store = createPolicyRegistrationStore();

    const error = capturedRegistrationError(() =>
      store.register({
        kind: "point",
        name: "early",
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        priority: -10,
        fn: () => PolicyDecision.allow({ policyId: "early" }),
      }),
    );

    expect(error.code).toBe("invalid_canonical_registration");
    expect(store.selectPoint("run.turn.pre")).toHaveLength(0);
  });

  it("rejects non-finite canonical priorities at the registration boundary", () => {
    const store = createPolicyRegistrationStore();

    const error = capturedRegistrationError(() =>
      store.register({
        kind: "point",
        name: "non-finite-priority",
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        priority: Number.POSITIVE_INFINITY,
        fn: () => PolicyDecision.allow({ policyId: "non-finite-priority" }),
      }),
    );

    expect(error.code).toBe("invalid_canonical_registration");
    expect(store.selectPoint("run.turn.pre")).toHaveLength(0);
  });

  it("creates independent engine instances with no shared state", async () => {
    const { engine: engine1, events: events1 } = createAuditedEngine();
    const { engine: engine2, events: events2 } = createAuditedEngine();

    engine1.add({
      kind: "point",
      name: "policy-1",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "engine1.policy" }),
    });

    engine2.add({
      kind: "point",
      name: "policy-2",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.deny({ policyId: "engine2.policy" }),
    });

    const ctx = createDispatchContext();

    const decision1 = await engine1.dispatchPoint("run.turn.pre", ctx);
    const decision2 = await engine2.dispatchPoint("run.turn.pre", ctx);

    expect(decision1.verdict).toBe("allow");
    expect(decision2.verdict).toBe("deny");
    // An audited dispatch emits the middleware debug plus the two policy
    // events; the count is pinned so a lost event is a failure, not a silence.
    expect(events1).toHaveLength(3);
    expect(events2).toHaveLength(3);
    expect(debugEvent(events1)?.data).toMatchObject({
      context: { name: "policy-1", verdict: "allow" },
    });
    expect(debugEvent(events2)?.data).toMatchObject({
      context: { name: "policy-2", verdict: "deny" },
    });
    // ...and neither engine ever observes the other's registration.
    expect(JSON.stringify(events1)).not.toContain("policy-2");
    expect(JSON.stringify(events2)).not.toContain("policy-1");
  });

  it("dispatches policy and fires audit callback without Bus", async () => {
    const { engine, events } = createAuditedEngine();

    engine.add({
      kind: "point",
      name: "test-policy",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.allow({ policyId: "test.allow" }),
    });

    const decision = await engine.dispatchPoint("run.turn.pre", createDispatchContext());

    expect(decision.verdict).toBe("allow");
    expect(events.some(({ name }) => name === Operational.Events.Debug.name)).toBe(true);
  });

  it("denies and fires audit callback on deny verdict", async () => {
    const { engine, events } = createAuditedEngine();

    engine.add({
      kind: "point",
      name: "deny-policy",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: () => PolicyDecision.deny({ policyId: "test.deny" }),
    });

    const decision = await engine.dispatchPoint("run.turn.pre", createDispatchContext());

    expect(decision.verdict).toBe("deny");
    expect(events.some(({ name }) => name === Operational.Events.Debug.name)).toBe(true);
  });

  it("runs without server, session, or agent bootstrap", async () => {
    const { engine, events } = createAuditedEngine();
    let invocations = 0;
    let observedAgentType: unknown;
    let observedResourceDescriptor: unknown;

    engine.add({
      kind: "point",
      name: "standalone-policy",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 100,
      fn: (ctx) => {
        invocations += 1;
        observedAgentType = ctx.agentType;
        observedResourceDescriptor = ctx.resourceDescriptor;
        return PolicyDecision.allow({ policyId: "standalone" });
      },
    });

    const context = createDispatchContext();
    const decision = await engine.dispatchPoint("run.turn.pre", context);

    expect(invocations).toBe(1);
    expect(observedAgentType).toBe("resident");
    expect(observedResourceDescriptor).toEqual(context.resourceDescriptor);
    expect(decision.verdict).toBe("allow");
    expect(events.some(({ name }) => name === Operational.Events.Debug.name)).toBe(true);
  });
});
