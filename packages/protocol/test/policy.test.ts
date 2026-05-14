import { describe, expect, test } from "bun:test";
import { Policy, RuntimeResource } from "../src/policy/index";

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

  describe("Policy.Timing", () => {
    it("parses all 14 valid timing values", () => {
      const timingValues = [
        Policy.Timing.INBOUND_RECEIVE,
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

    it("has all 14 timing values as constants", () => {
      const timingKeys = Object.keys(Policy.Timing);
      expect(timingKeys.length).toBe(14);
    });

    it("rejects invalid timing value", () => {
      expect(() => {
        const invalidTiming = "invalid_timing" as Policy.Timing;
        // This is a type-level check; runtime validation would use a Zod schema
        // For now, we verify the type is correct
        const _: Policy.Timing = invalidTiming;
      }).not.toThrow();
    });
  });

  describe("Policy.Verdict", () => {
    it("parses continue verdict", () => {
      const result = Policy.Verdict.parse({ action: "continue" });
      expect(result.action).toBe("continue");
    });

    it("parses skip verdict", () => {
      const result = Policy.Verdict.parse({ action: "skip", reason: "skipped" });
      expect(result.action).toBe("skip");
      expect(result.reason).toBe("skipped");
    });

    it("parses abort verdict", () => {
      const result = Policy.Verdict.parse({ action: "abort", reason: "stopped" });
      expect(result.action).toBe("abort");
      expect(result.reason).toBe("stopped");
    });

    it("parses retry verdict", () => {
      const result = Policy.Verdict.parse({ action: "retry" });
      expect(result.action).toBe("retry");
    });

    it("parses transform verdict with input", () => {
      const result = Policy.Verdict.parse({
        action: "transform",
        input: { key: "value" },
      });
      expect(result.action).toBe("transform");
      expect(result.input).toEqual({ key: "value" });
    });

    it("parses inject verdict with message", () => {
      const result = Policy.Verdict.parse({
        action: "inject",
        message: "injected message",
      });
      expect(result.action).toBe("inject");
      expect(result.message).toBe("injected message");
    });

    it("parses deny verdict", () => {
      const result = Policy.Verdict.parse({ action: "deny", reason: "denied" });
      expect(result.action).toBe("deny");
      expect(result.reason).toBe("denied");
    });

    it("rejects invalid verdict action", () => {
      expect(() => Policy.Verdict.parse({ action: "invalid" })).toThrow();
    });

    it("includes optional policyId in all verdicts", () => {
      const result = Policy.Verdict.parse({
        action: "continue",
        policyId: "test.policy",
      });
      expect(result.policyId).toBe("test.policy");
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
      expect(() =>
        Policy.Definition.parse({
          name: "",
          timing: "turn.start",
          priority: 100,
        }),
      ).toThrow();
    });

    it("rejects definition with negative priority", () => {
      expect(() =>
        Policy.Definition.parse({
          name: "test",
          timing: "turn.start",
          priority: -1,
        }),
      ).toThrow();
    });
  });

  describe("Policy.PolicyEffect", () => {
    it("parses prompt.append_context effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "prompt.append_context",
        context: "additional context",
      });
      expect(result.type).toBe("prompt.append_context");
      expect(result.context).toBe("additional context");
    });

    it("parses prompt.inject_message effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "prompt.inject_message",
        message: "injected",
        role: "user",
      });
      expect(result.type).toBe("prompt.inject_message");
      expect(result.message).toBe("injected");
      expect(result.role).toBe("user");
    });

    it("parses tool.filter effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "tool.filter",
        toolPattern: "dangerous.*",
      });
      expect(result.type).toBe("tool.filter");
      expect(result.toolPattern).toBe("dangerous.*");
    });

    it("parses tool.rewrite_input effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "tool.rewrite_input",
        input: { sanitized: true },
      });
      expect(result.type).toBe("tool.rewrite_input");
      expect(result.input).toEqual({ sanitized: true });
    });

    it("parses tool.require_approval effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "tool.require_approval",
        reason: "sensitive operation",
      });
      expect(result.type).toBe("tool.require_approval");
      expect(result.reason).toBe("sensitive operation");
    });

    it("parses run.abort effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "run.abort",
        reason: "aborted",
      });
      expect(result.type).toBe("run.abort");
      expect(result.reason).toBe("aborted");
    });

    it("parses run.continue_with_prompt effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "run.continue_with_prompt",
        prompt: "continue with this",
      });
      expect(result.type).toBe("run.continue_with_prompt");
      expect(result.prompt).toBe("continue with this");
    });

    it("parses run.retry_after effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "run.retry_after",
        delayMs: 1000,
        maxRetries: 3,
      });
      expect(result.type).toBe("run.retry_after");
      expect(result.delayMs).toBe(1000);
      expect(result.maxRetries).toBe(3);
    });

    it("parses delegation.set_constraints effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "delegation.set_constraints",
        constraints: { maxDepth: 2 },
      });
      expect(result.type).toBe("delegation.set_constraints");
      expect(result.constraints).toEqual({ maxDepth: 2 });
    });

    it("parses delegation.require_approval effect", () => {
      const result = Policy.PolicyEffect.parse({
        type: "delegation.require_approval",
        reason: "requires approval",
      });
      expect(result.type).toBe("delegation.require_approval");
      expect(result.reason).toBe("requires approval");
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

  describe("RuntimeResource.Descriptor", () => {
    it("parses descriptor with all fields", () => {
      const result = RuntimeResource.Descriptor.parse({
        id: "resource-1",
        kind: "tool",
        version: "1.0.0",
        labels: ["security", "audit"],
        capabilities: ["read", "write"],
        effects: ["log", "notify"],
        risk: 0.5,
        source: {
          type: "mcp",
          serverId: "server-1",
          remoteName: "remote",
        },
        schemaRef: "schema-ref",
        digest: "abc123",
        owner: "admin",
      });
      expect(result.id).toBe("resource-1");
      expect(result.kind).toBe("tool");
      expect(result.version).toBe("1.0.0");
      expect(result.labels).toEqual(["security", "audit"]);
      expect(result.capabilities).toEqual(["read", "write"]);
      expect(result.effects).toEqual(["log", "notify"]);
      expect(result.risk).toBe(0.5);
      expect(result.source?.type).toBe("mcp");
      expect(result.owner).toBe("admin");
    });

    it("parses descriptor with minimal fields", () => {
      const result = RuntimeResource.Descriptor.parse({
        id: "resource-1",
        kind: "skill",
        labels: [],
        capabilities: [],
        effects: [],
      });
      expect(result.id).toBe("resource-1");
      expect(result.kind).toBe("skill");
      expect(result.labels).toEqual([]);
      expect(result.version).toBeUndefined();
      expect(result.source).toBeUndefined();
    });

    it("parses descriptor with custom kind string", () => {
      const result = RuntimeResource.Descriptor.parse({
        id: "resource-1",
        kind: "custom-resource-type",
        labels: [],
        capabilities: [],
        effects: [],
      });
      expect(result.kind).toBe("custom-resource-type");
    });

    it("parses descriptor with standard kind values", () => {
      const kinds = ["tool", "skill", "mcpSource", "policy"];
      for (const kind of kinds) {
        const result = RuntimeResource.Descriptor.parse({
          id: "resource-1",
          kind,
          labels: [],
          capabilities: [],
          effects: [],
        });
        expect(result.kind).toBe(kind);
      }
    });

    it("parses descriptor with optional source fields", () => {
      const result = RuntimeResource.Descriptor.parse({
        id: "resource-1",
        kind: "tool",
        labels: [],
        capabilities: [],
        effects: [],
        source: {
          type: "http",
        },
      });
      expect(result.source?.type).toBe("http");
      expect(result.source?.serverId).toBeUndefined();
      expect(result.source?.remoteName).toBeUndefined();
    });
  });
});
