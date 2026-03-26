import { describe, expect, it } from "bun:test";
import { Guardrail } from "../src/guardrail/index";

describe("Guardrail schemas", () => {
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
        budgetPolicy: "inherit",
        abortPropagation: true,
      });
      expect(result.maxDepth).toBe(3);
      expect(result.budgetPolicy).toBe("inherit");
      expect(result.abortPropagation).toBe(true);
    });

    it("parses with explicit maxDepth", () => {
      const result = Guardrail.DelegationPolicy.parse({
        maxDepth: 5,
        budgetPolicy: "independent",
        abortPropagation: false,
      });
      expect(result.maxDepth).toBe(5);
    });

    it("rejects invalid budgetPolicy", () => {
      expect(() =>
        Guardrail.DelegationPolicy.parse({
          budgetPolicy: "shared",
          abortPropagation: true,
        }),
      ).toThrow();
    });
  });
});
