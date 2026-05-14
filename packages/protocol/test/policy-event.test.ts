import { describe, expect, test } from "bun:test";
import { PolicyEvent } from "../src/event/policy.js";
import type { Policy, RuntimeResource } from "../src/policy/index.js";

describe("PolicyEvent BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };
  const actor = { userId: "user-1", role: "admin" };

  const expectParseOk = (parse: () => unknown) => {
    let thrown: unknown;

    try {
      parse();
    } catch (error) {
      thrown = error;
    }

    expect(thrown === undefined).toBe(true);
  };

  test("ActionRequested parses with required fields", () => {
    expectParseOk(() =>
      PolicyEvent.ActionRequested.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
      }),
    );
  });

  test("ActionRequested parses with optional context", () => {
    expectParseOk(() =>
      PolicyEvent.ActionRequested.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        context: { toolName: "bash", args: { command: "ls" } },
      }),
    );
  });

  test("Evaluated parses with required fields", () => {
    expectParseOk(() =>
      PolicyEvent.Evaluated.schema.parse({
        ...base,
        policyId: "policy-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "continue",
        reason: "user has admin role",
      }),
    );
  });

  test("Evaluated parses with beforeSideEffect", () => {
    expectParseOk(() =>
      PolicyEvent.Evaluated.schema.parse({
        ...base,
        policyId: "policy-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "transform",
        reason: "sanitizing input",
        beforeSideEffect: { originalInput: "dangerous" },
      }),
    );
  });

  test("Evaluated parses with policy audit context", () => {
    expectParseOk(() =>
      PolicyEvent.Evaluated.schema.parse({
        ...base,
        policyId: "policy-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "continue",
        reason: "composed allow",
        effects: [{ type: "audit.annotate", annotation: "allowed" } satisfies Policy.PolicyEffect],
        obligations: [{ type: "human_approval", reason: "needs review" }],
        reasonCodes: ["allowlist_match"],
        factsUsed: ["actor.role=admin"],
        durationMs: 12,
        pointId: "tool.native.pre",
        pointVersion: 1,
        resourceDescriptor: {
          id: "tool:shell",
          kind: "tool",
          labels: ["tool.shell"],
          capabilities: ["execute"],
          effects: ["audit.annotate"],
        } satisfies RuntimeResource.Descriptor,
      }),
    );
  });

  test("DecisionComposed parses merged decision context", () => {
    expectParseOk(() =>
      PolicyEvent.DecisionComposed.schema.parse({
        ...base,
        pointId: "tool.native.pre",
        pointVersion: 1,
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "allow",
        reason: "merged allow",
        effects: [{ type: "audit.annotate", annotation: "merged" } satisfies Policy.PolicyEffect],
        reasonCodes: ["policy_a", "policy_b"],
      }),
    );
  });

  test("ActionBlocked parses", () => {
    expectParseOk(() =>
      PolicyEvent.ActionBlocked.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "abort",
        reason: "user lacks required permission",
      }),
    );
  });

  test("ActionApproved parses", () => {
    expectParseOk(() =>
      PolicyEvent.ActionApproved.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "continue",
        reason: "approved by policy",
      }),
    );
  });

  test("all verdict types are accepted", () => {
    const verdicts = ["continue", "skip", "abort", "retry", "transform", "inject"] as const;

    for (const verdict of verdicts) {
      expectParseOk(() =>
        PolicyEvent.ActionBlocked.schema.parse({
          ...base,
          actionId: "action-1",
          actor,
          action: "test.action",
          resource: "test:resource",
          verdict,
          reason: `testing ${verdict}`,
        }),
      );
    }
  });

  test("ActionRequested includes runId when provided", () => {
    const parsed = PolicyEvent.ActionRequested.schema.parse({
      ...base,
      runId: "run-123",
      actionId: "action-1",
      actor,
      action: "tool.execute",
      resource: "tool:shell",
    });

    expect(parsed.runId).toBe("run-123");
  });

  test("event descriptors have correct names", () => {
    expect(PolicyEvent.ActionRequested.name).toBe("policy.action.requested");
    expect(PolicyEvent.Evaluated.name).toBe("policy.evaluated");
    expect(PolicyEvent.DecisionComposed.name).toBe("policy.decision.composed");
    expect(PolicyEvent.ActionBlocked.name).toBe("policy.action.blocked");
    expect(PolicyEvent.ActionApproved.name).toBe("policy.action.approved");
  });

  test("event descriptors have schemas", () => {
    expect(PolicyEvent.ActionRequested.schema != null).toBe(true);
    expect(PolicyEvent.Evaluated.schema != null).toBe(true);
    expect(PolicyEvent.DecisionComposed.schema != null).toBe(true);
    expect(PolicyEvent.ActionBlocked.schema != null).toBe(true);
    expect(PolicyEvent.ActionApproved.schema != null).toBe(true);
  });

  test("policy audit events are persistent", () => {
    expect(PolicyEvent.Evaluated.visibility).not.toBe("ephemeral");
    expect(PolicyEvent.DecisionComposed.visibility).not.toBe("ephemeral");
  });
});
