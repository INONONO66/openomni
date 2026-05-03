import { describe, expect, it } from "bun:test";
import { ToolGuard } from "../../src/core/tool-guard";

describe("ToolGuard.check", () => {
  it("allows tool when no restrictions (undefined allowlist)", () => {
    expect(ToolGuard.check("any_tool", {}, { action: "tool.call" })).toBe("allow");
  });

  it("denies tool on denylist", () => {
    expect(
      ToolGuard.check("dangerous_tool", {}, { action: "tool.call", denylist: ["dangerous_tool"] }),
    ).toBe("deny");
  });

  it("allows tool not on denylist", () => {
    expect(
      ToolGuard.check("safe_tool", {}, { action: "tool.call", denylist: ["dangerous_tool"] }),
    ).toBe("allow");
  });

  it("denies all tools when allowlist is empty array", () => {
    expect(ToolGuard.check("any_tool", {}, { action: "tool.call", allowlist: [] })).toBe("deny");
  });

  it("allows all tools when allowlist contains wildcard *", () => {
    expect(ToolGuard.check("any_tool", {}, { action: "tool.call", allowlist: ["*"] })).toBe(
      "allow",
    );
  });

  it("allows tool explicitly in allowlist", () => {
    expect(
      ToolGuard.check("allowed_tool", {}, { action: "tool.call", allowlist: ["allowed_tool"] }),
    ).toBe("allow");
  });

  it("denies tool not in allowlist", () => {
    expect(
      ToolGuard.check("other_tool", {}, { action: "tool.call", allowlist: ["allowed_tool"] }),
    ).toBe("deny");
  });

  it("allows tool matching prefix wildcard mcp.*", () => {
    expect(ToolGuard.check("mcp.search", {}, { action: "tool.call", allowlist: ["mcp.*"] })).toBe(
      "allow",
    );
  });

  it("denies tool not matching prefix wildcard", () => {
    expect(ToolGuard.check("other.search", {}, { action: "tool.call", allowlist: ["mcp.*"] })).toBe(
      "deny",
    );
  });

  it("returns require_approval for tool in requireApproval list", () => {
    expect(
      ToolGuard.check(
        "sensitive_tool",
        {},
        {
          action: "tool.call",
          requireApproval: ["sensitive_tool"],
        },
      ),
    ).toBe("require_approval");
  });

  it("denylist takes priority over requireApproval", () => {
    expect(
      ToolGuard.check(
        "tool",
        {},
        {
          action: "tool.call",
          denylist: ["tool"],
          requireApproval: ["tool"],
        },
      ),
    ).toBe("deny");
  });

  it("input rule denies bash with rm -rf pattern", () => {
    expect(
      ToolGuard.check(
        "bash",
        { command: "rm -rf /" },
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "rm\\s+-rf",
              action: "deny",
              priority: 10,
            },
          ],
        },
      ),
    ).toBe("deny");
  });

  it("input rule allows non-matching command", () => {
    expect(
      ToolGuard.check(
        "bash",
        { command: "ls -la" },
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "rm\\s+-rf",
              action: "deny",
              priority: 10,
            },
          ],
        },
      ),
    ).toBe("allow");
  });

  it("input rule priority: higher priority wins", () => {
    expect(
      ToolGuard.check(
        "bash",
        { command: "sudo apt install" },
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "sudo",
              action: "require_approval",
              priority: 5,
            },
            {
              toolPattern: "bash",
              field: "command",
              pattern: "sudo",
              action: "deny",
              priority: 10,
            },
          ],
        },
      ),
    ).toBe("deny");
  });

  it("invalid regex pattern falls back gracefully", () => {
    expect(
      ToolGuard.check(
        "bash",
        { command: "test" },
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "[invalid",
              action: "deny",
              priority: 10,
            },
          ],
        },
      ),
    ).toBe("allow");
  });

  it("rejects regex patterns longer than 200 characters", () => {
    expect(
      ToolGuard.check(
        "bash",
        { command: "safe" },
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "a".repeat(201),
              action: "deny",
              priority: 10,
            },
          ],
        },
      ),
    ).toBe("allow");
  });

  it("truncates long input values before regex matching", () => {
    expect(
      ToolGuard.check(
        "bash",
        { command: `${"a".repeat(10_000)}b` },
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "b$",
              action: "deny",
              priority: 10,
            },
          ],
        },
      ),
    ).toBe("allow");
  });

  it("input rule with wildcard toolPattern matches all tools", () => {
    expect(
      ToolGuard.check(
        "file_edit",
        { filePath: "/etc/passwd" },
        {
          action: "tool.call",
          inputRules: [
            { toolPattern: "*", field: "filePath", pattern: "^/etc/", action: "deny", priority: 5 },
          ],
        },
      ),
    ).toBe("deny");
  });
});
