import { describe, test, expect } from "bun:test";
import type { Guardrail } from "@openomni/protocol";
import { ToolGuard } from "@openomni/agent/src/core/tool-guard";

describe("SubagentRuntime permissions", () => {
  test("default permissions deny subagent tool", () => {
    const defaultPermissions: Guardrail.Permission = {
      action: "tool.call",
      denylist: ["subagent"],
    };

    const verdict = ToolGuard.check("subagent", {}, defaultPermissions);
    expect(verdict).toBe("deny");
  });

  test("explicit allowlist permits specified tools", () => {
    const permissions: Guardrail.Permission = {
      action: "tool.call",
      allowlist: ["read_file", "write_file"],
    };

    const allowedVerdict = ToolGuard.check("read_file", {}, permissions);
    expect(allowedVerdict).toBe("allow");

    const deniedVerdict = ToolGuard.check("subagent", {}, permissions);
    expect(deniedVerdict).toBe("deny");
  });

  test("denylist blocks specified tools", () => {
    const permissions: Guardrail.Permission = {
      action: "tool.call",
      denylist: ["dangerous_tool", "delete_file"],
    };

    const deniedVerdict = ToolGuard.check("delete_file", {}, permissions);
    expect(deniedVerdict).toBe("deny");

    const allowedVerdict = ToolGuard.check("read_file", {}, permissions);
    expect(allowedVerdict).toBe("allow");
  });

  test("requireApproval verdict is returned correctly", () => {
    const permissions: Guardrail.Permission = {
      action: "tool.call",
      requireApproval: ["dangerous_operation"],
    };

    const verdict = ToolGuard.check("dangerous_operation", {}, permissions);
    expect(verdict).toBe("require_approval");
  });

  test("invalid regex in inputRule does not match, falls through to default allow", () => {
    const permissions: Guardrail.Permission = {
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

    const verdict = ToolGuard.check("test_tool", { input_field: "value" }, permissions);
    expect(verdict).toBe("allow");
  });

  test("invalid regex with denylist fallback still denies", () => {
    const permissions: Guardrail.Permission = {
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

    const verdict = ToolGuard.check("test_tool", { input_field: "value" }, permissions);
    expect(verdict).toBe("deny");
  });

  test("wildcard allowlist permits all tools", () => {
    const permissions: Guardrail.Permission = {
      action: "tool.call",
      allowlist: ["*"],
    };

    const verdict1 = ToolGuard.check("any_tool", {}, permissions);
    expect(verdict1).toBe("allow");

    const verdict2 = ToolGuard.check("another_tool", {}, permissions);
    expect(verdict2).toBe("allow");
  });

  test("prefix pattern matching in allowlist", () => {
    const permissions: Guardrail.Permission = {
      action: "tool.call",
      allowlist: ["file.*"],
    };

    const allowedVerdict = ToolGuard.check("file.read", {}, permissions);
    expect(allowedVerdict).toBe("allow");

    const deniedVerdict = ToolGuard.check("network.read", {}, permissions);
    expect(deniedVerdict).toBe("deny");
  });
});
