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
  test("warns under the trace instead of silently dropping audit records without a sessionId", async () => {
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      // A trace but no session: the audit record cannot be filed (an audit
      // row without its session names nothing queryable), but the drop must
      // be visible as an Operational.Warn under the real trace.
      traceContext: { traceId: "trace-audit-drop" },
      auditEmit: (event, data) => events.push({ name: event.name, data }),
    });
    engine.register({
      kind: "point",
      name: "drop-witness",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "drop-witness" }),
    });

    await engine.dispatchPoint("dispatch.action.pre", {
      actor: { kind: "system", actorId: "system:test" },
      dispatchId: "dispatch-audit-drop",
      action: "resident.ask",
      target: { kind: "resident" },
      sessionId: "session-audit-drop",
      runId: "run-audit-drop",
    });

    const auditRecords = events.filter(({ name }) =>
      [PolicyEvent.Evaluated.name, PolicyEvent.DecisionComposed.name].includes(name),
    );
    expect(auditRecords).toHaveLength(0);

    const dropWarnings = events.filter(
      ({ name, data }) =>
        name === "operational.warn" &&
        (data as { msg?: string }).msg === "audit record dropped: missing sessionId",
    );
    // One warn per dropped record: the evaluated event and the composed event.
    expect(dropWarnings).toHaveLength(2);
    expect(dropWarnings[0]?.data).toMatchObject({
      traceId: "trace-audit-drop",
      component: "agent.policy",
      context: { verdict: "allow" },
    });
    expect(
      dropWarnings.map(({ data }) => (data as { context: { event: string } }).context.event).sort(),
    ).toEqual([PolicyEvent.DecisionComposed.name, PolicyEvent.Evaluated.name].sort());
  });

  test("preserves safe correlation when canonical context snapshot fails", async () => {
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      auditEmit: (event, data) => events.push({ name: event.name, data }),
    });
    // The snapshot exists to protect a policy from a mutable context, so it is
    // only built for a point that has one. Register here to exercise it.
    engine.register({
      kind: "point",
      name: "snapshot-consumer",
      pointIds: ["dispatch.action.pre"],
      effectCapabilities: { "dispatch.action.pre": [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "snapshot-consumer" }),
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
