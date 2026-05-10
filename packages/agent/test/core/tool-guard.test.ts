import { describe, expect, it } from "bun:test";
import { createToolGuardMiddleware } from "../../src/core/middleware/builtin/tool-guard";
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

  it("preserves require_approval when an input rule supplies a custom reason", () => {
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
              reason: "destructive_command",
              priority: 5,
            },
          ],
        },
      ),
    ).toBe("require_approval");
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

describe("ToolGuard.evaluate", () => {
  it("uses canonical exact matching", () => {
    expect(
      ToolGuard.evaluate("bash", {}, { action: "tool.call", allowlist: ["bash"] }),
    ).toMatchObject({ action: "continue", reason: "allowlist", matchedPattern: "bash" });
  });

  it("uses canonical wildcard matching", () => {
    expect(
      ToolGuard.evaluate("file.read", {}, { action: "tool.call", allowlist: ["*"] }),
    ).toMatchObject({ action: "continue", reason: "allowlist", matchedPattern: "*" });
  });

  it("uses canonical prefix matching", () => {
    expect(
      ToolGuard.evaluate("mcp.search", {}, { action: "tool.call", allowlist: ["mcp.*"] }),
    ).toMatchObject({ action: "continue", reason: "allowlist", matchedPattern: "mcp.*" });
  });

  it("gives denylist precedence over requireApproval and allowlist", () => {
    expect(
      ToolGuard.evaluate(
        "bash",
        {},
        {
          action: "tool.call",
          denylist: ["bash"],
          requireApproval: ["bash"],
          allowlist: ["bash"],
        },
      ),
    ).toMatchObject({ action: "abort", reason: "denylist", matchedPattern: "bash" });
  });

  it("returns the canonical require-approval abort reason", () => {
    expect(
      ToolGuard.evaluate("bash", {}, { action: "tool.call", requireApproval: ["bash"] }),
    ).toMatchObject({
      action: "abort",
      reason: "require_approval",
      policyId: "guardrail.permission",
    });
  });

  it("returns the canonical allowlist miss reason", () => {
    expect(
      ToolGuard.evaluate("bash", {}, { action: "tool.call", allowlist: ["file.*"] }),
    ).toMatchObject({ action: "abort", reason: "allowlist_miss" });
  });
});

describe("createToolGuardMiddleware", () => {
  it("returns Guardrail.evaluate policy details for aborts", async () => {
    const middleware = createToolGuardMiddleware({
      permission: { action: "tool.call", allowlist: ["file.*"] },
    });

    const verdict = await middleware.fn({
      timing: "pre_tool_use",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: "bash",
      toolCallId: "call-1",
      toolInput: {},
    });

    expect(verdict).toMatchObject({
      action: "abort",
      reason: "allowlist_miss",
      policyId: "guardrail.permission",
    });
  });

  it("invokes stepGuard when an input rule with a custom reason requests approval", async () => {
    let stepGuardCalls = 0;
    const middleware = createToolGuardMiddleware({
      permission: {
        action: "tool.call",
        inputRules: [
          {
            toolPattern: "bash",
            field: "command",
            pattern: "sudo",
            action: "require_approval",
            reason: "destructive_command",
            priority: 5,
          },
        ],
      },
      stepGuard: () => {
        stepGuardCalls += 1;
        return { action: "continue" };
      },
    });

    const verdict = await middleware.fn({
      timing: "pre_tool_use",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: "bash",
      toolCallId: "call-1",
      toolInput: { command: "sudo apt install" },
    });

    expect(stepGuardCalls).toBe(1);
    expect(verdict).toMatchObject({
      action: "continue",
      reason: "destructive_command",
      policyId: "guardrail.permission",
    });
  });
});
