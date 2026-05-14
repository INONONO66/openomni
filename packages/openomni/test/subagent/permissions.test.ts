import { describe, test, expect } from "bun:test";
import { Policy } from "@openomni/protocol";
import { SubagentSpawnPolicyMiddleware } from "../../src/subagent";
import { intersectPermissions } from "../../src/execution-runtime/tool/agent/tools/subagent-runtime";

function checkPermission(
  toolName: string,
  input: Record<string, unknown>,
  permission: Policy.Permission,
): "allow" | "deny" | "require_approval" {
  const result = Policy.evaluate(permission, {
    action: "tool.call",
    resource: toolName,
    input,
  });
  if (result.decision !== undefined) return result.decision;
  return result.action === "continue" ? "allow" : "deny";
}

describe("SubagentRuntime permissions", () => {
  test("default subagent middleware denies recursive subagent tool calls", async () => {
    const registration = SubagentSpawnPolicyMiddleware.createDefaultDenylist();

    const verdict = await registration.fn({
      timing: "invoke.prepare",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: "subagent",
      toolInput: {},
    });

    expect(verdict.action).toBe("abort");
    expect(verdict.reason).toBe("denylist");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  test("explicit allowlist permits specified tools", () => {
    const permissions: Policy.Permission = {
      action: "tool.call",
      allowlist: ["read_file", "write_file"],
    };

    const allowedVerdict = checkPermission("read_file", {}, permissions);
    expect(allowedVerdict).toBe("allow");

    const deniedVerdict = checkPermission("subagent", {}, permissions);
    expect(deniedVerdict).toBe("deny");
  });

  test("denylist blocks specified tools", () => {
    const permissions: Policy.Permission = {
      action: "tool.call",
      denylist: ["dangerous_tool", "delete_file"],
    };

    const deniedVerdict = checkPermission("delete_file", {}, permissions);
    expect(deniedVerdict).toBe("deny");

    const allowedVerdict = checkPermission("read_file", {}, permissions);
    expect(allowedVerdict).toBe("allow");
  });

  test("requireApproval verdict is returned correctly", () => {
    const permissions: Policy.Permission = {
      action: "tool.call",
      requireApproval: ["dangerous_operation"],
    };

    const verdict = checkPermission("dangerous_operation", {}, permissions);
    expect(verdict).toBe("require_approval");
  });

  test("invalid regex in inputRule does not match, falls through to default allow", () => {
    const permissions: Policy.Permission = {
      action: "tool.call",
      inputRules: [
        {
          toolPattern: "test_tool",
          field: "input_field",
          pattern: "[invalid regex",
          action: "deny",
          priority: 0,
        },
      ],
    };

    const verdict = checkPermission("test_tool", { input_field: "value" }, permissions);
    expect(verdict).toBe("allow");
  });

  test("invalid regex with denylist fallback still denies", () => {
    const permissions: Policy.Permission = {
      action: "tool.call",
      denylist: ["test_tool"],
      inputRules: [
        {
          toolPattern: "test_tool",
          field: "input_field",
          pattern: "[invalid regex",
          action: "allow",
          priority: 0,
        },
      ],
    };

    const verdict = checkPermission("test_tool", { input_field: "value" }, permissions);
    expect(verdict).toBe("deny");
  });

  test("wildcard allowlist permits all tools", () => {
    const permissions: Policy.Permission = {
      action: "tool.call",
      allowlist: ["*"],
    };

    const verdict1 = checkPermission("any_tool", {}, permissions);
    expect(verdict1).toBe("allow");

    const verdict2 = checkPermission("another_tool", {}, permissions);
    expect(verdict2).toBe("allow");
  });

  test("prefix pattern matching in allowlist", () => {
    const permissions: Policy.Permission = {
      action: "tool.call",
      allowlist: ["file.*"],
    };

    const allowedVerdict = checkPermission("file.read", {}, permissions);
    expect(allowedVerdict).toBe("allow");

    const deniedVerdict = checkPermission("network.read", {}, permissions);
    expect(deniedVerdict).toBe("deny");
  });

  test("subagent permission intersection preserves parent label constraints", () => {
    const merged = intersectPermissions(
      {
        action: "tool.call",
        allowLabels: ["capability:read"],
        denyLabels: ["risk:tier-2"],
      },
      {
        action: "tool.call",
        allowLabels: ["capability:read", "capability:write"],
        requireApprovalLabels: ["source:mcp"],
      },
    );

    expect(merged).toMatchObject({
      action: "tool.call",
      allowLabels: ["capability:read"],
      denyLabels: ["risk:tier-2"],
      requireApprovalLabels: ["source:mcp"],
    });
  });
});
