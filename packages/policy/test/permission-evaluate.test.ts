import { describe, expect, test } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { decisionFromEvaluation, evaluatePermission } from "@openomni/policy";

const it = test;

// Moved from packages/protocol/test/policy.test.ts with the evaluation engine
// (#498 W1): protocol keeps the schemas, this package owns the behavior.
describe("evaluatePermission", () => {
  const request = (
    resource: string,
    input?: Record<string, unknown>,
  ): Policy.EvaluationRequest => ({
    action: "tool.call",
    resource,
    ...(input !== undefined ? { input } : {}),
  });

  it("allows by default", () => {
    expect(evaluatePermission({ action: "tool.call" }, request("any_tool"))).toMatchObject({
      action: "continue",
      reason: "default_allow",
      policyId: "guardrail.permission",
    });
  });

  it("aborts on action mismatch", () => {
    expect(evaluatePermission({ action: "task.create" }, request("any_tool"))).toMatchObject({
      action: "abort",
      reason: "action_mismatch",
      policyId: "guardrail.permission",
    });
  });

  it("denies resources matched by denylist", () => {
    expect(
      evaluatePermission(
        { action: "tool.call", denylist: ["dangerous_tool"] },
        request("dangerous_tool"),
      ),
    ).toMatchObject({
      action: "abort",
      reason: "denylist",
      policyId: "guardrail.permission",
      matchedPattern: "dangerous_tool",
    });
  });

  it("allows only resources matched by allowlist", () => {
    const permission = { action: "tool.call", allowlist: ["safe_tool"] };

    expect(evaluatePermission(permission, request("safe_tool"))).toMatchObject({
      action: "continue",
      reason: "allowlist",
      policyId: "guardrail.permission",
    });
    expect(evaluatePermission(permission, request("other_tool"))).toMatchObject({
      action: "abort",
      reason: "allowlist_miss",
      policyId: "guardrail.permission",
    });
  });

  it("evaluates resource labels after explicit deny and approval lists", () => {
    const permission: Policy.Permission = {
      action: "tool.call",
      allowLabels: ["capability:read"],
      denyLabels: ["capability:destructive"],
      requireApprovalLabels: ["risk:tier-2"],
    };

    expect(
      evaluatePermission(permission, {
        ...request("read"),
        resourceLabels: ["capability:read", "source:system"],
      }),
    ).toMatchObject({
      action: "continue",
      reason: "allow_label",
      matchedPattern: "capability:read",
    });

    expect(
      evaluatePermission(permission, {
        ...request("rm"),
        resourceLabels: ["capability:destructive", "risk:tier-2"],
      }),
    ).toMatchObject({
      action: "abort",
      decision: "deny",
      reason: "deny_label",
      matchedPattern: "capability:destructive",
    });

    expect(
      evaluatePermission(permission, {
        ...request("bash"),
        resourceLabels: ["risk:tier-2"],
      }),
    ).toMatchObject({
      action: "abort",
      decision: "require_approval",
      reason: "require_approval_label",
      matchedPattern: "risk:tier-2",
    });
  });

  it("aborts when allowlist is empty", () => {
    expect(
      evaluatePermission({ action: "tool.call", allowlist: [] }, request("safe_tool")),
    ).toMatchObject({
      action: "abort",
      reason: "allowlist_empty",
      policyId: "guardrail.permission",
    });
  });

  it("requires approval for matched resources", () => {
    expect(
      evaluatePermission(
        { action: "tool.call", requireApproval: ["sensitive_tool"] },
        request("sensitive_tool"),
      ),
    ).toMatchObject({
      action: "abort",
      reason: "require_approval",
      policyId: "guardrail.permission",
      matchedPattern: "sensitive_tool",
    });
  });

  it("matches wildcard for all policy lists", () => {
    expect(
      evaluatePermission({ action: "tool.call", allowlist: ["*"] }, request("file.read")),
    ).toMatchObject({
      action: "continue",
      reason: "allowlist",
      policyId: "guardrail.permission",
      matchedPattern: "*",
    });
    expect(
      evaluatePermission({ action: "tool.call", denylist: ["*"] }, request("file.read")),
    ).toMatchObject({
      action: "abort",
      reason: "denylist",
      policyId: "guardrail.permission",
      matchedPattern: "*",
    });
    expect(
      evaluatePermission({ action: "tool.call", requireApproval: ["*"] }, request("file.read")),
    ).toMatchObject({
      action: "abort",
      reason: "require_approval",
      policyId: "guardrail.permission",
      matchedPattern: "*",
    });
  });

  it("matches prefix wildcard for all policy lists", () => {
    expect(
      evaluatePermission({ action: "tool.call", allowlist: ["file.*"] }, request("file.read")),
    ).toMatchObject({
      action: "continue",
      reason: "allowlist",
      policyId: "guardrail.permission",
      matchedPattern: "file.*",
    });
    expect(
      evaluatePermission({ action: "tool.call", denylist: ["file.*"] }, request("file.read")),
    ).toMatchObject({
      action: "abort",
      reason: "denylist",
      policyId: "guardrail.permission",
      matchedPattern: "file.*",
    });
    expect(
      evaluatePermission(
        { action: "tool.call", requireApproval: ["file.*"] },
        request("file.read"),
      ),
    ).toMatchObject({
      action: "abort",
      reason: "require_approval",
      policyId: "guardrail.permission",
      matchedPattern: "file.*",
    });
    expect(
      evaluatePermission(
        { action: "tool.call", allowlist: ["file.*"] },
        request("filesystem.read"),
      ),
    ).toMatchObject({
      action: "abort",
      reason: "allowlist_miss",
      policyId: "guardrail.permission",
    });
  });

  it("gives denylist precedence over approval and allowlist matches", () => {
    expect(
      evaluatePermission(
        {
          action: "tool.call",
          allowlist: ["*"],
          denylist: ["file.*"],
          requireApproval: ["file.read"],
        },
        request("file.read"),
      ),
    ).toMatchObject({
      action: "abort",
      reason: "denylist",
      policyId: "guardrail.permission",
      matchedPattern: "file.*",
    });
  });

  it("populates decision for every result branch", () => {
    const allowDefault = evaluatePermission(undefined, request("bash"));
    expect(allowDefault.decision).toBe("allow");
    expect(allowDefault.action).toBe("continue");

    const allowList = evaluatePermission(
      { action: "tool.call", allowlist: ["bash"] },
      request("bash"),
    );
    expect(allowList.decision).toBe("allow");

    const denyList = evaluatePermission(
      { action: "tool.call", denylist: ["bash"] },
      request("bash"),
    );
    expect(denyList.decision).toBe("deny");

    const requireApproval = evaluatePermission(
      { action: "tool.call", requireApproval: ["bash"] },
      request("bash"),
    );
    expect(requireApproval.decision).toBe("require_approval");
    expect(requireApproval.action).toBe("abort");

    const allowMiss = evaluatePermission(
      { action: "tool.call", allowlist: ["other"] },
      request("bash"),
    );
    expect(allowMiss.decision).toBe("deny");

    const actionMismatch = evaluatePermission(
      { action: "channel.send", allowlist: ["*"] },
      request("bash"),
    );
    expect(actionMismatch.decision).toBe("deny");
  });

  it("preserves require_approval decision when an input rule supplies a custom reason", () => {
    const result = evaluatePermission(
      {
        action: "tool.call",
        inputRules: [
          {
            toolPattern: "bash",
            field: "command",
            pattern: "^sudo",
            action: "require_approval",
            reason: "destructive_command",
            priority: 5,
          },
        ],
      },
      request("bash", { command: "sudo rm -rf /" }),
    );

    expect(result).toMatchObject({
      action: "abort",
      decision: "require_approval",
      reason: "destructive_command",
      policyId: "guardrail.permission",
      matchedPattern: "bash",
    });
  });

  it("fails closed when unsafe or invalid runtime input rules reach evaluation", () => {
    for (const pattern of ["^a*a*a*$", "("]) {
      expect(
        evaluatePermission(
          {
            action: "tool.call",
            allowlist: ["*"],
            inputRules: [
              {
                toolPattern: "bash",
                field: "command",
                pattern,
                action: "allow",
                priority: 100,
              },
            ],
          },
          request("bash", { command: "aaaaab" }),
        ),
      ).toMatchObject({
        action: "abort",
        decision: "deny",
        reason: "unsafe_input_rule",
        matchedPattern: "bash",
      });
    }
  });

  it("uses highest priority matching input rule before list policies", () => {
    expect(
      evaluatePermission(
        {
          action: "tool.call",
          denylist: ["bash"],
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "^npm",
              action: "deny",
              priority: 1,
            },
            {
              toolPattern: "bash",
              field: "command",
              pattern: "^npm test$",
              action: "allow",
              reason: "safe command",
              priority: 10,
            },
          ],
        },
        request("bash", { command: "npm test" }),
      ),
    ).toMatchObject({
      action: "continue",
      reason: "safe command",
      policyId: "guardrail.permission",
      matchedPattern: "bash",
    });
  });
});

describe("decisionFromEvaluation", () => {
  it("maps continue to a bare allow decision", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", allowlist: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
    );

    expect(decision).toEqual({
      policyId: "guardrail.permission",
      verdict: "allow",
      effects: [],
      reasonCodes: ["allowlist"],
    });
  });

  it("maps abort to a deny with abort and audit effects", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", denylist: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
    );

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toEqual(["denylist"]);
    expect(decision.effects).toEqual([
      { type: "run.abort", reason: "denylist" },
      { type: "audit.annotate", annotation: "denylist", severity: "error" },
    ]);
  });

  it("honors a caller-supplied deny effect and policyId", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", denylist: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
      {
        policyId: "custom.guard",
        denyEffect: { type: "tool.skip_invocation", reason: "denylist" },
      },
    );

    expect(decision.policyId).toBe("custom.guard");
    expect(decision.effects[0]).toEqual({ type: "tool.skip_invocation", reason: "denylist" });
  });

  it("maps require_approval to a pending decision with a human-approval obligation", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", requireApproval: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
    );

    expect(decision.verdict).toBe("pending");
    expect(decision.effects).toEqual([
      { type: "tool.require_approval", reason: "require_approval" },
    ]);
    expect(decision.obligations).toEqual([
      {
        obligationId: "guardrail.permission.approval",
        type: "humanApproval",
        description: "require_approval",
      },
    ]);
  });
});
