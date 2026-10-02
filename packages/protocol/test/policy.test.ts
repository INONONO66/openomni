import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { Policy, PolicyDecision } from "../src/policy/index";

const it = test;

describe("Policy schemas", () => {
  describe("InputRule", () => {
    it("parses a basic rule", () => {
      const result = Policy.Permission.shape.inputRules.unwrap().element.parse({
        toolPattern: "bash",
        field: "command",
        pattern: "rm",
        action: "deny",
      });

      expect(result.toolPattern).toBe("bash");
      expect(result.priority).toBe(0);
    });

    it("parses a rule with reason and priority", () => {
      const result = Policy.Permission.shape.inputRules.unwrap().element.parse({
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
          Policy.Permission.shape.inputRules.unwrap().element.parse({
            toolPattern: "bash",
            field: "command",
            pattern,
            action: "deny",
          }),
        ).toThrow(ZodError);
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
          Policy.Permission.shape.inputRules.unwrap().element.safeParse({
            toolPattern: "bash",
            field: "command",
            pattern,
            action: "deny",
          }).success,
        ).toBe(true);
      }
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
    });

    it("creates deny and pending decisions as blocking", () => {
      const deny = PolicyDecision.deny({ policyId: "deny.policy", reasonCodes: ["denied"] });
      const pending = PolicyDecision.pending({
        policyId: "pending.policy",
        reasonCodes: ["needs_approval"],
      });

      expect(deny.verdict).toBe("deny");
      expect(pending.verdict).toBe("pending");
      expect(PolicyDecision.reason(deny)).toBe("denied");
      expect(PolicyDecision.reason(pending)).toBe("needs_approval");
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

    it("parses run.replace_messages carrying a JSON-plain array", () => {
      const result = Policy.PolicyEffect.parse({
        type: "run.replace_messages",
        messages: [{ role: "user", content: "rewritten" }, "plain"],
      });
      expect(result).toMatchObject({
        type: "run.replace_messages",
        messages: [{ role: "user", content: "rewritten" }, "plain"],
      });
    });

    it("parses model.override effect (#753) — connection-scoped model routing", () => {
      const result = Policy.PolicyEffect.parse({
        type: "model.override",
        provider: "anthropic",
        id: "claude-3-haiku-20240307",
      });
      expect(result).toMatchObject({
        type: "model.override",
        provider: "anthropic",
        id: "claude-3-haiku-20240307",
      });
    });

    it("refuses a model.override with empty coordinates, naming the offending field", () => {
      const emptyProvider = Policy.PolicyEffect.safeParse({
        type: "model.override",
        provider: "",
        id: "m",
      });
      expect(emptyProvider.success).toBe(false);
      if (!emptyProvider.success) {
        expect(emptyProvider.error.issues.map((issue) => issue.path.join("."))).toContain(
          "provider",
        );
        expect(emptyProvider.error.issues.every((issue) => issue.code === "too_small")).toBe(true);
      }
      const emptyId = Policy.PolicyEffect.safeParse({
        type: "model.override",
        provider: "p",
        id: "",
      });
      expect(emptyId.success).toBe(false);
      if (!emptyId.success) {
        expect(emptyId.error.issues.map((issue) => issue.path.join("."))).toContain("id");
      }
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

    it("parses audit.annotate effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "audit.annotate",
        annotation: "audit note",
        severity: "warning",
      });
      expect(result).toEqual({
        type: "audit.annotate",
        annotation: "audit note",
        severity: "warning",
      });
    });
  });
});
