import { describe, expect, test } from "bun:test";
import { Policy } from "../src/policy/index";

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
});
