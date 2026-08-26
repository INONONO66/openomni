import { describe, expect, test } from "bun:test";
import { Policy } from "../src/policy/index.js";

describe("Policy.Events BusEvents", () => {
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
      Policy.Events.ActionRequested.schema.parse({
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
      Policy.Events.ActionRequested.schema.parse({
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
      Policy.Events.Evaluated.schema.parse({
        ...base,
        policyId: "policy-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "allow",
        reason: "user has admin role",
      }),
    );
  });

  test("Evaluated parses with beforeSideEffect", () => {
    expectParseOk(() =>
      Policy.Events.Evaluated.schema.parse({
        ...base,
        policyId: "policy-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "pending",
        reason: "sanitizing input",
        beforeSideEffect: { originalInput: "dangerous" },
      }),
    );
  });

  test("Evaluated parses with policy audit context", () => {
    expectParseOk(() =>
      Policy.Events.Evaluated.schema.parse({
        ...base,
        policyId: "policy-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "allow",
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
        } satisfies Policy.Resource.Descriptor,
      }),
    );
  });

  test("DecisionComposed parses merged decision context", () => {
    expectParseOk(() =>
      Policy.Events.DecisionComposed.schema.parse({
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
      Policy.Events.ActionBlocked.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "deny",
        reason: "user lacks required permission",
      }),
    );
  });

  test("all verdict types are accepted", () => {
    const verdicts = ["allow", "deny", "pending"] as const;

    for (const verdict of verdicts) {
      expectParseOk(() =>
        Policy.Events.ActionBlocked.schema.parse({
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

  test("Evaluated parses with deny verdict", () => {
    expectParseOk(() =>
      Policy.Events.Evaluated.schema.parse({
        ...base,
        policyId: "policy-deny",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "deny",
        reason: "access denied by policy",
      }),
    );
  });

  test("ActionRequested includes runId when provided", () => {
    const parsed = Policy.Events.ActionRequested.schema.parse({
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
    expect(Policy.Events.ActionRequested.name).toBe("policy.action.requested");
    expect(Policy.Events.Evaluated.name).toBe("policy.evaluated");
    expect(Policy.Events.DecisionComposed.name).toBe("policy.decision.composed");
    expect(Policy.Events.ActionBlocked.name).toBe("policy.action.blocked");
  });

  test("event descriptors have schemas", () => {
    expect(Policy.Events.ActionRequested.schema != null).toBe(true);
    expect(Policy.Events.Evaluated.schema != null).toBe(true);
    expect(Policy.Events.DecisionComposed.schema != null).toBe(true);
    expect(Policy.Events.ActionBlocked.schema != null).toBe(true);
  });

  test("policy audit events are persistent", () => {
    expect(Policy.Events.Evaluated.visibility).not.toBe("ephemeral");
    expect(Policy.Events.DecisionComposed.visibility).not.toBe("ephemeral");
  });
});
