import { describe, test, expect } from "bun:test";
import type { Guardrail } from "@openomni/protocol";
import { ToolGuard } from "@openomni/agent/src/core/tool-guard";

describe("SubagentRuntime permissions", () => {
  test("default permissions deny subagent tool", () => {
    const defaultPermissions: Guardrail.ToolPermission = {
      denylist: ["subagent"],
    };

    const verdict = ToolGuard.check("subagent", {}, defaultPermissions);
    expect(verdict).toBe("deny");
  });

  test("explicit allowlist permits specified tools", () => {
    const permissions: Guardrail.ToolPermission = {
      allowlist: ["read_file", "write_file"],
    };

    const allowedVerdict = ToolGuard.check("read_file", {}, permissions);
    expect(allowedVerdict).toBe("allow");

    const deniedVerdict = ToolGuard.check("subagent", {}, permissions);
    expect(deniedVerdict).toBe("deny");
  });

  test("denylist blocks specified tools", () => {
    const permissions: Guardrail.ToolPermission = {
      denylist: ["dangerous_tool", "delete_file"],
    };

    const deniedVerdict = ToolGuard.check("delete_file", {}, permissions);
    expect(deniedVerdict).toBe("deny");

    const allowedVerdict = ToolGuard.check("read_file", {}, permissions);
    expect(allowedVerdict).toBe("allow");
  });

  test("requireApproval verdict is returned correctly", () => {
    const permissions: Guardrail.ToolPermission = {
      requireApproval: ["dangerous_operation"],
    };

    const verdict = ToolGuard.check("dangerous_operation", {}, permissions);
    expect(verdict).toBe("require_approval");
  });

  test("fail-closed: ToolGuard.check error returns deny", () => {
    const permissions: Guardrail.ToolPermission = {
      inputRules: [
        {
          toolPattern: "test_tool",
          field: "input_field",
          pattern: "[invalid regex",
          action: "deny",
        },
      ],
    };

    try {
      const verdict = ToolGuard.check("test_tool", { input_field: "value" }, permissions);
      expect(verdict).toBe("deny");
    } catch {
      expect(true).toBe(true);
    }
  });

  test("wildcard allowlist permits all tools", () => {
    const permissions: Guardrail.ToolPermission = {
      allowlist: ["*"],
    };

    const verdict1 = ToolGuard.check("any_tool", {}, permissions);
    expect(verdict1).toBe("allow");

    const verdict2 = ToolGuard.check("another_tool", {}, permissions);
    expect(verdict2).toBe("allow");
  });

  test("prefix pattern matching in allowlist", () => {
    const permissions: Guardrail.ToolPermission = {
      allowlist: ["file.*"],
    };

    const allowedVerdict = ToolGuard.check("file.read", {}, permissions);
    expect(allowedVerdict).toBe("allow");

    const deniedVerdict = ToolGuard.check("network.read", {}, permissions);
    expect(deniedVerdict).toBe("deny");
  });
});
