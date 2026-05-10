import { describe, expect, test } from "bun:test";
import { PolicyEvent } from "../src/event/policy.js";

describe("PolicyEvent BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };
  const actor = { userId: "user-1", role: "admin" };

  test("ActionRequested parses with required fields", () => {
    expect(() =>
      PolicyEvent.ActionRequested.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
      }),
    ).not.toThrow();
  });

  test("ActionRequested parses with optional context", () => {
    expect(() =>
      PolicyEvent.ActionRequested.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        context: { toolName: "bash", args: { command: "ls" } },
      }),
    ).not.toThrow();
  });

  test("Evaluated parses with required fields", () => {
    expect(() =>
      PolicyEvent.Evaluated.schema.parse({
        ...base,
        policyId: "policy-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "continue",
        reason: "user has admin role",
      }),
    ).not.toThrow();
  });

  test("Evaluated parses with beforeSideEffect", () => {
    expect(() =>
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
    ).not.toThrow();
  });

  test("ActionBlocked parses", () => {
    expect(() =>
      PolicyEvent.ActionBlocked.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "abort",
        reason: "user lacks required permission",
      }),
    ).not.toThrow();
  });

  test("ActionApproved parses", () => {
    expect(() =>
      PolicyEvent.ActionApproved.schema.parse({
        ...base,
        actionId: "action-1",
        actor,
        action: "tool.execute",
        resource: "tool:shell",
        verdict: "continue",
        reason: "approved by policy",
      }),
    ).not.toThrow();
  });

  test("all verdict types are accepted", () => {
    const verdicts = ["continue", "skip", "abort", "retry", "transform", "inject"] as const;

    for (const verdict of verdicts) {
      expect(() =>
        PolicyEvent.ActionBlocked.schema.parse({
          ...base,
          actionId: "action-1",
          actor,
          action: "test.action",
          resource: "test:resource",
          verdict,
          reason: `testing ${verdict}`,
        }),
      ).not.toThrow();
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
    expect(PolicyEvent.ActionBlocked.name).toBe("policy.action.blocked");
    expect(PolicyEvent.ActionApproved.name).toBe("policy.action.approved");
  });

  test("event descriptors have schemas", () => {
    expect(PolicyEvent.ActionRequested.schema).toBeDefined();
    expect(PolicyEvent.Evaluated.schema).toBeDefined();
    expect(PolicyEvent.ActionBlocked.schema).toBeDefined();
    expect(PolicyEvent.ActionApproved.schema).toBeDefined();
  });
});
