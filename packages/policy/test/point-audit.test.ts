import { describe, expect, test } from "bun:test";
import { Policy, PolicyDecision } from "@openomni/protocol";
import { createPolicyEngine } from "../src/engine/dispatch";

const PolicyEngine = { create: createPolicyEngine };

describe("PolicyEngine canonical point audit", () => {
  test("stamps evaluated and composed events with the dispatched point", async () => {
    // Given
    const pointId = "dispatch.action.pre" as const;
    const traceContext = {
      traceId: "trace-canonical-audit",
      sessionId: "session-canonical-audit",
      runId: "run-canonical-audit",
    } as const;
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      clock: () => 1_234,
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

    // When
    await engine.dispatchPoint(pointId, {
      actor: { kind: "system", actorId: "system:test" },
      dispatchId: "dispatch-audit",
      action: "resident.ask",
      target: { kind: "resident" },
      sessionId: traceContext.sessionId,
      runId: traceContext.runId,
    });

    // Then
    const evaluated = Policy.Events.Evaluated.schema.parse(
      events.find(({ name }) => name === Policy.Events.Evaluated.name)?.data,
    );
    const composed = Policy.Events.DecisionComposed.schema.parse(
      events.find(({ name }) => name === Policy.Events.DecisionComposed.name)?.data,
    );
    const pointVersion = Policy.PolicyPoint.Registry[pointId].version;

    expect(evaluated).toMatchObject({
      ...traceContext,
      pointId,
      pointVersion,
      time: 1_234,
      durationMs: 0,
    });
    expect(composed).toMatchObject({
      ...traceContext,
      pointId,
      pointVersion,
      time: 1_234,
      durationMs: 0,
    });
  });
  test("warns under the trace instead of silently dropping audit records without a sessionId", async () => {
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      clock: Date.now,
      // A trace but no session: the audit record cannot be filed (an audit
      // row without its session names nothing queryable), but the drop must
      // be visible as an Operational.Events.Warn under the real trace.
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
      [Policy.Events.Evaluated.name, Policy.Events.DecisionComposed.name].includes(name),
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
    ).toEqual([Policy.Events.DecisionComposed.name, Policy.Events.Evaluated.name].sort());
  });

  test("preserves safe correlation when canonical context snapshot fails", async () => {
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      clock: Date.now,
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
