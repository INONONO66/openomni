import { describe, expect, test } from "bun:test";
import { Policy, PolicyDecision, PolicyEvent } from "@openomni/protocol";
import { PolicyEngine } from "@openomni/policy";

describe("PolicyEngine canonical point audit", () => {
  test("stamps evaluated and composed events with the dispatched point", async () => {
    // Given
    const pointId = "dispatch.action.pre" as const;
    const timing = Policy.Timing.DISPATCH_AUTHORIZE;
    const originalMapping = Policy.PolicyPoint.MigrationMapping[timing];
    const traceContext = {
      traceId: "trace-canonical-audit",
      sessionId: "session-canonical-audit",
      runId: "run-canonical-audit",
    } as const;
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      traceContext,
      auditEmit: (event, data) => events.push({ name: event.name, data }),
    });
    engine.register({
      kind: "point",
      name: "canonical-audit",
      pointIds: [pointId],
      effectCapabilities: { [pointId]: [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "canonical-audit" }),
    });

    Reflect.set(Policy.PolicyPoint.MigrationMapping, timing, ["run.lifecycle.pre"]);
    try {
      // When
      await engine.dispatchPoint(pointId, {
        actor: { kind: "system", actorId: "system:test" },
        dispatchId: "dispatch-audit",
        action: "resident.ask",
        target: { kind: "resident" },
        sessionId: traceContext.sessionId,
        runId: traceContext.runId,
      });
    } finally {
      Reflect.set(Policy.PolicyPoint.MigrationMapping, timing, originalMapping);
    }

    // Then
    const evaluated = PolicyEvent.Evaluated.schema.parse(
      events.find(({ name }) => name === PolicyEvent.Evaluated.name)?.data,
    );
    const composed = PolicyEvent.DecisionComposed.schema.parse(
      events.find(({ name }) => name === PolicyEvent.DecisionComposed.name)?.data,
    );
    const pointVersion = Policy.PolicyPoint.Registry[pointId].version;

    expect(evaluated).toMatchObject({ ...traceContext, pointId, pointVersion });
    expect(composed).toMatchObject({ ...traceContext, pointId, pointVersion });
  });
  test("preserves safe correlation when canonical context snapshot fails", async () => {
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      auditEmit: (event, data) => events.push({ name: event.name, data }),
    });
    const traceContext = {
      traceId: "trace-invalid-context",
      sessionId: "session-invalid-context",
      runId: "run-invalid-context",
    } as const;

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      actor: { kind: "system", actorId: "system:test" },
      dispatchId: "dispatch-invalid-context",
      action: "resident.ask",
      target: { kind: "resident" },
      sessionId: traceContext.sessionId,
      runId: traceContext.runId,
      traceContext,
      unsupported: new Map([["mutable", true]]),
    });

    expect(decision.reasonCodes).toContain("policy.input_invalid");
    for (const event of events) {
      expect(event.data).toMatchObject(traceContext);
    }
  });
});
