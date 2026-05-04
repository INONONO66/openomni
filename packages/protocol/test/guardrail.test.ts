import { describe, expect, test } from "bun:test";
import { Guardrail } from "../src/guardrail/index";

const it = test;

describe("Guardrail schemas", () => {
  describe("InputRule", () => {
    it("parses a basic rule", () => {
      const result = Guardrail.InputRule.parse({
        toolPattern: "bash",
        field: "command",
        pattern: "rm",
        action: "deny",
      });

      expect(result.toolPattern).toBe("bash");
      expect(result.priority).toBe(0);
    });

    it("parses a rule with reason and priority", () => {
      const result = Guardrail.InputRule.parse({
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
      const result = Guardrail.Permission.parse({ action: "tool.call" });

      expect(result.action).toBe("tool.call");
    });

    it("parses with allowlist", () => {
      const result = Guardrail.Permission.parse({
        action: "tool.call",
        allowlist: ["tool_a", "tool_b"],
      });
      expect(result.allowlist).toEqual(["tool_a", "tool_b"]);
    });

    it("parses with denylist", () => {
      const result = Guardrail.Permission.parse({
        action: "tool.call",
        denylist: ["dangerous"],
      });
      expect(result.denylist).toEqual(["dangerous"]);
    });

    it("parses with requireApproval", () => {
      const result = Guardrail.Permission.parse({
        action: "tool.call",
        requireApproval: ["sensitive"],
      });
      expect(result.requireApproval).toEqual(["sensitive"]);
    });

    it("parses with inputRules", () => {
      const result = Guardrail.Permission.parse({
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
    ): Guardrail.EvaluationRequest => ({
      action: "tool.call",
      resource,
      input,
    });

    it("allows by default", () => {
      expect(Guardrail.evaluate({ action: "tool.call" }, request("any_tool"))).toMatchObject({
        action: "continue",
        reason: "default_allow",
        policyId: "guardrail.permission",
      });
    });

    it("aborts on action mismatch", () => {
      expect(Guardrail.evaluate({ action: "task.create" }, request("any_tool"))).toMatchObject({
        action: "abort",
        reason: "action_mismatch",
        policyId: "guardrail.permission",
      });
    });

    it("denies resources matched by denylist", () => {
      expect(
        Guardrail.evaluate(
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

      expect(Guardrail.evaluate(permission, request("safe_tool"))).toMatchObject({
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
      });
      expect(Guardrail.evaluate(permission, request("other_tool"))).toMatchObject({
        action: "abort",
        reason: "allowlist_miss",
        policyId: "guardrail.permission",
      });
    });

    it("aborts when allowlist is empty", () => {
      expect(
        Guardrail.evaluate({ action: "tool.call", allowlist: [] }, request("safe_tool")),
      ).toMatchObject({
        action: "abort",
        reason: "allowlist_empty",
        policyId: "guardrail.permission",
      });
    });

    it("requires approval for matched resources", () => {
      expect(
        Guardrail.evaluate(
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
        Guardrail.evaluate({ action: "tool.call", allowlist: ["*"] }, request("file.read")),
      ).toMatchObject({
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      });
      expect(
        Guardrail.evaluate({ action: "tool.call", denylist: ["*"] }, request("file.read")),
      ).toMatchObject({
        action: "abort",
        reason: "denylist",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      });
      expect(
        Guardrail.evaluate({ action: "tool.call", requireApproval: ["*"] }, request("file.read")),
      ).toMatchObject({
        action: "abort",
        reason: "require_approval",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      });
    });

    it("matches prefix wildcard for all policy lists", () => {
      expect(
        Guardrail.evaluate({ action: "tool.call", allowlist: ["file.*"] }, request("file.read")),
      ).toMatchObject({
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      });
      expect(
        Guardrail.evaluate({ action: "tool.call", denylist: ["file.*"] }, request("file.read")),
      ).toMatchObject({
        action: "abort",
        reason: "denylist",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      });
      expect(
        Guardrail.evaluate(
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
        Guardrail.evaluate(
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
        Guardrail.evaluate(
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
      const allowDefault = Guardrail.evaluate(undefined, request("bash"));
      expect(allowDefault.decision).toBe("allow");
      expect(allowDefault.action).toBe("continue");

      const allowList = Guardrail.evaluate(
        { action: "tool.call", allowlist: ["bash"] },
        request("bash"),
      );
      expect(allowList.decision).toBe("allow");

      const denyList = Guardrail.evaluate(
        { action: "tool.call", denylist: ["bash"] },
        request("bash"),
      );
      expect(denyList.decision).toBe("deny");

      const requireApproval = Guardrail.evaluate(
        { action: "tool.call", requireApproval: ["bash"] },
        request("bash"),
      );
      expect(requireApproval.decision).toBe("require_approval");
      expect(requireApproval.action).toBe("abort");

      const allowMiss = Guardrail.evaluate(
        { action: "tool.call", allowlist: ["other"] },
        request("bash"),
      );
      expect(allowMiss.decision).toBe("deny");

      const actionMismatch = Guardrail.evaluate(
        { action: "channel.send", allowlist: ["*"] },
        request("bash"),
      );
      expect(actionMismatch.decision).toBe("deny");
    });

    it("preserves require_approval decision when an input rule supplies a custom reason", () => {
      const result = Guardrail.evaluate(
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
        Guardrail.evaluate(
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

  describe("GuardrailType", () => {
    it("accepts valid enum values", () => {
      expect(() => Guardrail.GuardrailType.parse("output_validation")).not.toThrow();
      expect(() => Guardrail.GuardrailType.parse("content_filter")).not.toThrow();
      expect(() => Guardrail.GuardrailType.parse("cost_limit")).not.toThrow();
      expect(() => Guardrail.GuardrailType.parse("custom")).not.toThrow();
    });

    it("rejects invalid value", () => {
      expect(() => Guardrail.GuardrailType.parse("invalid")).toThrow();
    });
  });

  describe("GuardrailSchema", () => {
    it("parses valid guardrail", () => {
      const result = Guardrail.GuardrailSchema.parse({
        type: "content_filter",
        rule: "no profanity",
        action: "reject",
      });
      expect(result.type).toBe("content_filter");
      expect(result.action).toBe("reject");
    });

    it("rejects invalid action", () => {
      expect(() =>
        Guardrail.GuardrailSchema.parse({
          type: "custom",
          rule: "test",
          action: "invalid_action",
        }),
      ).toThrow();
    });
  });

  describe("DelegationPolicy", () => {
    it("parses with defaults", () => {
      const result = Guardrail.DelegationPolicy.parse({
        abortPropagation: true,
      });
      expect(result.maxDepth).toBe(3);
      expect(result.abortPropagation).toBe(true);
    });

    it("parses with explicit maxDepth", () => {
      const result = Guardrail.DelegationPolicy.parse({
        maxDepth: 5,
        abortPropagation: false,
      });
      expect(result.maxDepth).toBe(5);
      expect(result.abortPropagation).toBe(false);
    });

    it("accepts float maxDepth", () =>
      expect(() =>
        Guardrail.DelegationPolicy.parse({
          maxDepth: 1.5,
          abortPropagation: true,
        }),
      ).not.toThrow());

    it("accepts negative maxDepth", () =>
      expect(() =>
        Guardrail.DelegationPolicy.parse({
          maxDepth: -1,
          abortPropagation: true,
        }),
      ).not.toThrow());

    it("accepts zero maxDepth", () =>
      expect(() =>
        Guardrail.DelegationPolicy.parse({
          maxDepth: 0,
          abortPropagation: true,
        }),
      ).not.toThrow());

    describe("action enum completeness", () => {
      ["reject", "retry", "warn", "escalate"].forEach((action) => {
        it(`accepts action "${action}"`, () =>
          expect(() =>
            Guardrail.GuardrailSchema.parse({
              type: "custom",
              rule: "r",
              action,
            }),
          ).not.toThrow());
      });
      it("empty allowlist accepted", () =>
        expect(() =>
          Guardrail.Permission.parse({ action: "tool.call", allowlist: [] }),
        ).not.toThrow());
    });
  });
});
