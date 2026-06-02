// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { Policy, PolicyDecision } from "../src/policy/index";

const it = test;

describe("Policy schemas", () => {
  describe("InputRule", () => {
    it("parses a basic rule", () => {
      const result = Policy.InputRule.parse({
        toolPattern: "bash",
        field: "command",
        pattern: "rm",
        action: "deny",
      });

      expect(result.toolPattern).toBe("bash");
      expect(result.priority).toBe(0);
    });

    it("parses a rule with reason and priority", () => {
      const result = Policy.InputRule.parse({
        toolPattern: "bash",
        field: "command",
        pattern: "rm",
        action: "deny",
        reason: "dangerous",
        priority: 10,
      });

      expect(result.reason).toBe("dangerous");
      expect(result.priority).toBe(10);
    });
  });

  describe("Permission", () => {
    it("parses action-only permission", () => {
      const result = Policy.Permission.parse({ action: "tool.call" });

      expect(result.action).toBe("tool.call");
    });

    it("parses with allowlist", () => {
      const result = Policy.Permission.parse({
        action: "tool.call",
        allowlist: ["tool_a", "tool_b"],
      });
      expect(result.allowlist).toEqual(["tool_a", "tool_b"]);
    });

    it("parses with denylist", () => {
      const result = Policy.Permission.parse({
        action: "tool.call",
        denylist: ["dangerous"],
      });
      expect(result.denylist).toEqual(["dangerous"]);
    });

    it("parses with requireApproval", () => {
      const result = Policy.Permission.parse({
        action: "tool.call",
        requireApproval: ["sensitive"],
      });
      expect(result.requireApproval).toEqual(["sensitive"]);
    });

    it("parses with inputRules", () => {
      const result = Policy.Permission.parse({
        action: "tool.call",
        inputRules: [
          {
            toolPattern: "bash",
            field: "command",
            pattern: "rm",
            action: "deny",
          },
        ],
      });

      expect(result.action).toBe("tool.call");

      expect(result.inputRules?.[0]).toMatchObject({
        toolPattern: "bash",
        field: "command",
        pattern: "rm",
        action: "deny",
        priority: 0,
      });
    });

    it("rejects unsafe regex patterns", () => {
      for (const pattern of [
        "(a+)+b",
        "^(a|aa)+$",
        "^(a{1,2})+$",
        "^a*a*a*$",
        String.raw`([\\]+)+b`,
        "((a)+)+$",
        "((a|aa))+$",
        "(a(b+))+c",
        "^(a+)(a+)(a+)(a+)(a+)(a+)(a+)(a+)(a+)(a+)(a+)(a+)$",
        String.raw`^(a)\1+$`,
        "^.*a.*a.*a.*a.*a.*a.*a.*a.*a.*a.*a.*a$",
      ]) {
        expect(() =>
          Policy.InputRule.parse({
            toolPattern: "bash",
            field: "command",
            pattern,
            action: "deny",
          }),
        ).toThrow();
      }
    });

    it("accepts linear regex patterns used by policy callsites", () => {
      for (const pattern of [
        String.raw`rm\s+-rf`,
        "^/safe/.*",
        "^(?!(?:user|main|trusted_manager)$).*$",
        String.raw`[\\]+`,
        String.raw`[a\\]*`,
      ]) {
        expect(
          Policy.InputRule.safeParse({
            toolPattern: "bash",
            field: "command",
            pattern,
            action: "deny",
          }).success,
        ).toBe(true);
      }
    });
  });

  describe("evaluate", () => {
    const request = (
      resource: string,
      input?: Record<string, unknown>,
    ): Policy.EvaluationRequest => ({
      action: "tool.call",
      resource,
      input,
    });

    it("allows by default", () => {
      expect(Policy.evaluate({ action: "tool.call" }, request("any_tool"))).toMatchObject({
        action: "continue",
        reason: "default_allow",
        policyId: "guardrail.permission",
      });
    });

    it("aborts on action mismatch", () => {
      expect(Policy.evaluate({ action: "task.create" }, request("any_tool"))).toMatchObject({
        action: "abort",
        reason: "action_mismatch",
        policyId: "guardrail.permission",
      });
    });

    it("denies resources matched by denylist", () => {
      expect(
        Policy.evaluate(
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

      expect(Policy.evaluate(permission, request("safe_tool"))).toMatchObject({
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
      });
      expect(Policy.evaluate(permission, request("other_tool"))).toMatchObject({
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
        Policy.evaluate(permission, {
          ...request("read"),
          resourceLabels: ["capability:read", "source:system"],
        }),
      ).toMatchObject({
        action: "continue",
        reason: "allow_label",
        matchedPattern: "capability:read",
      });

      expect(
        Policy.evaluate(permission, {
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
        Policy.evaluate(permission, {
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
        Policy.evaluate({ action: "tool.call", allowlist: [] }, request("safe_tool")),
      ).toMatchObject({
        action: "abort",
        reason: "allowlist_empty",
        policyId: "guardrail.permission",
      });
    });

    it("requires approval for matched resources", () => {
      expect(
        Policy.evaluate(
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
        Policy.evaluate({ action: "tool.call", allowlist: ["*"] }, request("file.read")),
      ).toMatchObject({
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      });
      expect(
        Policy.evaluate({ action: "tool.call", denylist: ["*"] }, request("file.read")),
      ).toMatchObject({
        action: "abort",
        reason: "denylist",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      });
      expect(
        Policy.evaluate({ action: "tool.call", requireApproval: ["*"] }, request("file.read")),
      ).toMatchObject({
        action: "abort",
        reason: "require_approval",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      });
    });

    it("matches prefix wildcard for all policy lists", () => {
      expect(
        Policy.evaluate({ action: "tool.call", allowlist: ["file.*"] }, request("file.read")),
      ).toMatchObject({
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      });
      expect(
        Policy.evaluate({ action: "tool.call", denylist: ["file.*"] }, request("file.read")),
      ).toMatchObject({
        action: "abort",
        reason: "denylist",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      });
      expect(
        Policy.evaluate({ action: "tool.call", requireApproval: ["file.*"] }, request("file.read")),
      ).toMatchObject({
        action: "abort",
        reason: "require_approval",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      });
      expect(
        Policy.evaluate({ action: "tool.call", allowlist: ["file.*"] }, request("filesystem.read")),
      ).toMatchObject({
        action: "abort",
        reason: "allowlist_miss",
        policyId: "guardrail.permission",
      });
    });

    it("gives denylist precedence over approval and allowlist matches", () => {
      expect(
        Policy.evaluate(
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
      const allowDefault = Policy.evaluate(undefined, request("bash"));
      expect(allowDefault.decision).toBe("allow");
      expect(allowDefault.action).toBe("continue");

      const allowList = Policy.evaluate(
        { action: "tool.call", allowlist: ["bash"] },
        request("bash"),
      );
      expect(allowList.decision).toBe("allow");

      const denyList = Policy.evaluate(
        { action: "tool.call", denylist: ["bash"] },
        request("bash"),
      );
      expect(denyList.decision).toBe("deny");

      const requireApproval = Policy.evaluate(
        { action: "tool.call", requireApproval: ["bash"] },
        request("bash"),
      );
      expect(requireApproval.decision).toBe("require_approval");
      expect(requireApproval.action).toBe("abort");

      const allowMiss = Policy.evaluate(
        { action: "tool.call", allowlist: ["other"] },
        request("bash"),
      );
      expect(allowMiss.decision).toBe("deny");

      const actionMismatch = Policy.evaluate(
        { action: "channel.send", allowlist: ["*"] },
        request("bash"),
      );
      expect(actionMismatch.decision).toBe("deny");
    });

    it("preserves require_approval decision when an input rule supplies a custom reason", () => {
      const result = Policy.evaluate(
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
          Policy.evaluate(
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
        Policy.evaluate(
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

  describe("Policy.Timing", () => {
    it("parses all 15 valid timing values", () => {
      const timingValues = [
        Policy.Timing.INBOUND_RECEIVE,
        Policy.Timing.DISPATCH_AUTHORIZE,
        Policy.Timing.RUN_START,
        Policy.Timing.TURN_START,
        Policy.Timing.CONTEXT_PREPARE,
        Policy.Timing.RESOURCES_PREPARE,
        Policy.Timing.MODEL_REQUEST,
        Policy.Timing.MODEL_RESPONSE,
        Policy.Timing.INVOKE_PREPARE,
        Policy.Timing.INVOKE_RESULT,
        Policy.Timing.TURN_FINISH,
        Policy.Timing.COMPLETION_PREPARE,
        Policy.Timing.WRITEBACK_COMMIT,
        Policy.Timing.RUN_FINISH,
        Policy.Timing.ERROR,
      ];

      expect(timingValues).toEqual([
        "inbound.receive",
        "dispatch.authorize",
        "run.start",
        "turn.start",
        "context.prepare",
        "resources.prepare",
        "model.request",
        "model.response",
        "invoke.prepare",
        "invoke.result",
        "turn.finish",
        "completion.prepare",
        "writeback.commit",
        "run.finish",
        "error",
      ]);
    });

    it("has all 15 timing values as constants", () => {
      const timingKeys = Object.keys(Policy.Timing);
      expect(timingKeys.length).toBe(15);
    });

    it("rejects invalid timing value", () => {
      const invalidTiming = "invalid_timing" as Policy.Timing;
      expect(invalidTiming).toBe("invalid_timing");
    });
  });

  describe("Policy.PolicyDecision", () => {
    const baseDecision = {
      policyId: "test.policy",
      effects: [],
      reasonCodes: ["matched"],
    };

    it("accepts canonical allow, deny, and pending verdicts", () => {
      for (const verdict of ["allow", "deny", "pending"] as const) {
        const result = Policy.PolicyDecision.parse({ ...baseDecision, verdict });
        expect(result.verdict).toBe(verdict);
      }
    });

    it("rejects legacy evaluator and effect verdict strings", () => {
      for (const verdict of ["continue", "abort", "transform", "inject"] as const) {
        expect(Policy.PolicyDecision.safeParse({ ...baseDecision, verdict }).success).toBe(false);
      }
    });

    it("rejects hybrid canonical decisions carrying legacy verdict keys", () => {
      expect(
        Policy.PolicyDecision.safeParse({
          ...baseDecision,
          verdict: "allow",
          action: "abort",
          reason: "legacy abort",
        }).success,
      ).toBe(false);
    });

    it("creates allow decisions with helper defaults", () => {
      const result = PolicyDecision.allow({ policyId: "test.policy" });
      expect(result).toEqual({
        policyId: "test.policy",
        verdict: "allow",
        effects: [],
        reasonCodes: [],
      });
      expect(PolicyDecision.isBlocking(result)).toBe(false);
    });

    it("creates deny and pending decisions as blocking", () => {
      const deny = PolicyDecision.deny({ policyId: "deny.policy", reasonCodes: ["denied"] });
      const pending = PolicyDecision.pending({
        policyId: "pending.policy",
        reasonCodes: ["needs_approval"],
      });

      expect(deny.verdict).toBe("deny");
      expect(pending.verdict).toBe("pending");
      expect(PolicyDecision.isBlocking(deny)).toBe(true);
      expect(PolicyDecision.isBlocking(pending)).toBe(true);
      expect(PolicyDecision.reason(deny)).toBe("denied");
      expect(PolicyDecision.reason(pending)).toBe("needs_approval");
    });
  });

  describe("Policy.Definition", () => {
    it("parses definition with single timing", () => {
      const result = Policy.Definition.parse({
        name: "test-policy",
        timing: "turn.start",
        priority: 100,
      });
      expect(result.name).toBe("test-policy");
      expect(result.timing).toBe("turn.start");
      expect(result.priority).toBe(100);
    });

    it("parses definition with multiple timings", () => {
      const result = Policy.Definition.parse({
        name: "test-policy",
        timing: ["turn.start", "turn.finish"],
        priority: 100,
      });
      expect(result.timing).toEqual(["turn.start", "turn.finish"]);
    });

    it("parses definition with scope", () => {
      const result = Policy.Definition.parse({
        name: "test-policy",
        timing: "turn.start",
        priority: 100,
        scope: { agentType: ["subagent", "worker"] },
      });
      expect(result.scope?.agentType).toEqual(["subagent", "worker"]);
    });

    it("parses definition with failPolicy", () => {
      const result = Policy.Definition.parse({
        name: "test-policy",
        timing: "turn.start",
        priority: 100,
        failPolicy: "fail-closed",
      });
      expect(result.failPolicy).toBe("fail-closed");
    });

    it("rejects definition with empty name", () => {
      expect(
        Policy.Definition.safeParse({
          name: "",
          timing: "turn.start",
          priority: 100,
        }).success,
      ).toBe(false);
    });

    it("rejects definition with negative priority", () => {
      expect(
        Policy.Definition.safeParse({
          name: "test",
          timing: "turn.start",
          priority: -1,
        }).success,
      ).toBe(false);
    });
  });

  describe("Policy.PolicyEffect", () => {
    it("parses prompt.append_context effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "prompt.append_context",
        context: "additional context",
      });
      expect(result).toMatchObject({
        type: "prompt.append_context",
        context: "additional context",
      });
    });

    it("parses prompt.inject_message effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "prompt.inject_message",
        message: "injected",
        role: "user",
      });
      expect(result).toMatchObject({
        type: "prompt.inject_message",
        message: "injected",
        role: "user",
      });
    });

    it("parses tool.filter effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "tool.filter",
        toolPattern: "dangerous.*",
      });
      expect(result).toMatchObject({ type: "tool.filter", toolPattern: "dangerous.*" });
    });

    it("parses tool.rewrite_input effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "tool.rewrite_input",
        input: { sanitized: true },
      });
      expect(result).toMatchObject({
        type: "tool.rewrite_input",
        input: { sanitized: true },
      });
    });

    it("parses tool.require_approval effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "tool.require_approval",
        reason: "sensitive operation",
      });
      expect(result).toMatchObject({
        type: "tool.require_approval",
        reason: "sensitive operation",
      });
    });

    it("parses run.abort effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "run.abort",
        reason: "aborted",
      });
      expect(result).toMatchObject({ type: "run.abort", reason: "aborted" });
    });

    it("parses run.continue_with_prompt effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "run.continue_with_prompt",
        prompt: "continue with this",
      });
      expect(result).toMatchObject({
        type: "run.continue_with_prompt",
        prompt: "continue with this",
      });
    });

    it("parses run.retry_after effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "run.retry_after",
        delayMs: 1000,
        maxRetries: 3,
      });
      expect(result).toMatchObject({
        type: "run.retry_after",
        delayMs: 1000,
        maxRetries: 3,
      });
    });

    it("parses delegation.set_constraints effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "delegation.set_constraints",
        constraints: { maxDepth: 2 },
      });
      expect(result).toMatchObject({
        type: "delegation.set_constraints",
        constraints: { maxDepth: 2 },
      });
    });

    it("parses delegation.require_approval effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "delegation.require_approval",
        reason: "requires approval",
      });
      expect(result).toMatchObject({
        type: "delegation.require_approval",
        reason: "requires approval",
      });
    });

    it("parses audit.annotate effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "audit.annotate",
        annotation: "audit note",
        severity: "warning",
      });
      expect(result.type).toBe("audit.annotate");
      expect(result.annotation).toBe("audit note");
      expect(result.severity).toBe("warning");
    });
  });

  describe("Policy.PolicyPoint", () => {
    it("parses policy point with timing and allowed effects", () => {
      const result = Policy.PolicyPoint.parse({
        point: "turn.start",
        allowedEffects: ["prompt.append_context", "tool.filter"],
        defaultFailPolicy: "fail-open",
      });
      expect(result.point).toBe("turn.start");
      expect(result.allowedEffects).toContain("prompt.append_context");
      expect(result.defaultFailPolicy).toBe("fail-open");
    });

    it("parses policy point with all allowed effect types", () => {
      const allEffects = [
        "prompt.append_context",
        "prompt.inject_message",
        "tool.filter",
        "tool.rewrite_input",
        "tool.require_approval",
        "run.abort",
        "run.continue_with_prompt",
        "run.retry_after",
        "delegation.set_constraints",
        "delegation.require_approval",
        "audit.annotate",
      ] as const;

      const result = Policy.PolicyPoint.parse({
        point: "invoke.prepare",
        allowedEffects: allEffects,
        defaultFailPolicy: "fail-closed",
      });
      expect(result.allowedEffects.length).toBe(11);
    });
  });

  describe("Policy.PolicyPlan", () => {
    it("parses policy plan with policies array", () => {
      const result = Policy.PolicyPlan.parse({
        policies: [
          { id: "policy-1", required: true },
          { id: "policy-2", required: false, config: { key: "value" } },
        ],
        labels: ["security", "audit"],
      });
      expect(result.policies.length).toBe(2);
      expect(result.policies[0].id).toBe("policy-1");
      expect(result.policies[0].required).toBe(true);
      expect(result.labels).toEqual(["security", "audit"]);
    });

    it("parses policy plan with registry version", () => {
      const result = Policy.PolicyPlan.parse({
        policies: [{ id: "policy-1", required: true }],
        labels: ["test"],
        registryVersion: "1.0.0",
      });
      expect(result.registryVersion).toBe("1.0.0");
    });

    it("rejects policy plan with empty policies array", () => {
      expect(() =>
        Policy.PolicyPlan.parse({
          policies: [],
          labels: ["test"],
        }),
      ).not.toThrow();
    });

    it("rejects policy with empty id", () => {
      expect(() =>
        Policy.PolicyPlan.parse({
          policies: [{ id: "", required: true }],
          labels: ["test"],
        }),
      ).toThrow();
    });
  });
});
