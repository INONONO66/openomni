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

  describe("ToolPermission", () => {
    it("parses empty object (all optional)", () => {
      expect(() => Guardrail.ToolPermission.parse({})).not.toThrow();
    });

    it("parses with allowlist", () => {
      const result = Guardrail.ToolPermission.parse({
        allowlist: ["tool_a", "tool_b"],
      });
      expect(result.allowlist).toEqual(["tool_a", "tool_b"]);
    });

    it("parses with denylist", () => {
      const result = Guardrail.ToolPermission.parse({
        denylist: ["dangerous"],
      });
      expect(result.denylist).toEqual(["dangerous"]);
    });

    it("parses with requireApproval", () => {
      const result = Guardrail.ToolPermission.parse({
        requireApproval: ["sensitive"],
      });
      expect(result.requireApproval).toEqual(["sensitive"]);
    });

    it("parses with inputRules", () => {
      const result = Guardrail.ToolPermission.parse({
        inputRules: [
          {
            toolPattern: "bash",
            field: "command",
            pattern: "rm",
            action: "deny",
          },
        ],
      });

      expect(result.inputRules?.[0]).toMatchObject({
        toolPattern: "bash",
        field: "command",
        pattern: "rm",
        action: "deny",
        priority: 0,
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
        expect(() => Guardrail.ToolPermission.parse({ allowlist: [] })).not.toThrow());
    });
  });
});
