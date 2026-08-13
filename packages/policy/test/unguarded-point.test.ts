import { describe, expect, test } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { PolicyDecision, PolicyEvent } from "@openomni/protocol";
import { PolicyEngine } from "@openomni/policy";

/**
 * A point with no registration is unguarded. Nothing will read its context, so
 * the engine does not clone or freeze it — the cost of materializing a context
 * is only worth paying when a policy is about to receive it.
 */
describe("PolicyEngine unguarded point dispatch", () => {
  function contextWithProbe(): {
    readonly context: Record<string, unknown>;
    reads(): number;
  } {
    let reads = 0;
    return {
      context: {
        sessionId: "session-1",
        runId: "run-1",
        turnIndex: 0,
        messages: [
          {
            get probe() {
              reads += 1;
              return "deep value";
            },
          },
        ],
      },
      reads: () => reads,
    };
  }

  test("does not descend into the context when no policy is registered", async () => {
    const engine = PolicyEngine.create();
    const probe = contextWithProbe();

    const decision = await engine.dispatchPoint(
      "run.turn.pre",
      probe.context as Policy.PolicyPointInputMap["run.turn.pre"],
    );

    expect(decision.verdict).toBe("allow");
    expect(probe.reads()).toBe(0);
  });

  test("descends into the context once a policy is registered at the point", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "context-consumer",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 0,
      fn: () => PolicyDecision.allow({ policyId: "context-consumer" }),
    });
    const probe = contextWithProbe();

    const decision = await engine.dispatchPoint(
      "run.turn.pre",
      probe.context as Policy.PolicyPointInputMap["run.turn.pre"],
    );

    expect(decision.verdict).toBe("allow");
    expect(probe.reads()).toBeGreaterThan(0);
  });

  test("still enforces the point contract with no registration", async () => {
    const engine = PolicyEngine.create();

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      actor: { kind: "system", actorId: "system:test" },
      dispatchId: "dispatch-1",
      action: "resident.ask",
    } as unknown as Policy.PolicyPointInputMap["dispatch.action.pre"]);

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.context_missing");
    expect(decision.effects.map((effect) => effect.type)).toEqual(["run.abort", "audit.annotate"]);
  });

  test("publishes a composed audit event carrying correlation", async () => {
    const events: Array<{ readonly name: string; readonly data: unknown }> = [];
    const engine = PolicyEngine.create({
      auditEmit: (event, data) => events.push({ name: event.name, data }),
    });
    const traceContext = {
      traceId: "trace-unguarded",
      sessionId: "session-unguarded",
      runId: "run-unguarded",
    } as const;

    await engine.dispatchPoint("run.turn.pre", {
      sessionId: traceContext.sessionId,
      runId: traceContext.runId,
      turnIndex: 0,
      traceContext,
    });

    const composed = events.find(({ name }) => name === PolicyEvent.DecisionComposed.name);
    expect(composed?.data).toMatchObject({ ...traceContext, verdict: "allow" });
  });

  /**
   * Snapshot-ability is a precondition for handing a context to a policy, not a
   * property of the context itself. With no policy at the point there is
   * nothing to hand it to, so a context that could never be frozen is allowed
   * through rather than denied.
   */
  test("allows a context that could not be snapshotted", async () => {
    const engine = PolicyEngine.create();

    const decision = await engine.dispatchPoint("run.turn.pre", {
      sessionId: "session-1",
      runId: "run-1",
      turnIndex: 0,
      unsupported: new Map([["mutable", true]]),
    });

    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toEqual([]);
  });
});
