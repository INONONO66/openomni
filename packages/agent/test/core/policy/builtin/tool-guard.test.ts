import { describe, expect, it } from "bun:test";
import { createToolPermissionPolicy } from "../../../../src/core/policy/builtin/tool-guard";
import type { PolicyContext } from "../../../../src/core/policy";
import type { AgentEventEmitter } from "../../../../src/core/types";

function baseCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    timing: "invoke.prepare",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("createToolPermissionPolicy", () => {
  it("continue — tool on allowlist", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", allowlist: ["read_file", "write_file"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "read_file",
        toolCallId: "call-1",
        toolInput: { path: "/tmp/test" },
      }),
    );
    expect(verdict.verdict).toBe("allow");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  it("abort — tool not on allowlist (allowlist_miss)", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", allowlist: ["read_file"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "shell_exec",
        toolCallId: "call-2",
        toolInput: { cmd: "rm -rf /" },
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("allowlist_miss");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  it("abort — tool on denylist", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", denylist: ["dangerous_tool"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "dangerous_tool",
        toolCallId: "call-3",
        toolInput: {},
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("denylist");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  it("abort — empty allowlist denies everything (allowlist_empty)", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", allowlist: [] },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "any_tool",
        toolCallId: "call-4",
        toolInput: {},
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("allowlist_empty");
  });

  it("continue — no toolName in context", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", allowlist: ["read_file"] },
    });
    const verdict = await mw.fn(baseCtx());
    expect(verdict.verdict).toBe("allow");
  });

  it("continue — wildcard allowlist allows everything", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", allowlist: ["*"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "anything",
        toolCallId: "call-5",
        toolInput: {},
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("abort — inputRule deny overrides allowlist", async () => {
    const mw = createToolPermissionPolicy({
      permission: {
        action: "tool.call",
        allowlist: ["shell_exec"],
        inputRules: [
          {
            toolPattern: "shell_exec",
            field: "cmd",
            pattern: "^rm\\s",
            action: "deny",
            reason: "destructive_command",
            priority: 10,
          },
        ],
      },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "shell_exec",
        toolCallId: "call-6",
        toolInput: { cmd: "rm -rf /tmp" },
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("destructive_command");
  });

  it("continue — permission without explicit action gets normalized to tool.call", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "", allowlist: ["read_file"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "read_file",
        toolCallId: "call-7",
        toolInput: {},
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("fails closed when permission evaluation throws", async () => {
    // Given
    const hostileInput = new Proxy<Record<string, unknown>>(
      {},
      {
        get: () => {
          throw new Error("hostile tool input");
        },
      },
    );
    const mw = createToolPermissionPolicy({
      permission: {
        action: "tool.call",
        inputRules: [
          {
            toolPattern: "shell_exec",
            field: "cmd",
            pattern: "^rm\\s",
            action: "deny",
            priority: 10,
          },
        ],
      },
    });

    // When
    const verdict = await mw.fn(
      baseCtx({
        toolName: "shell_exec",
        toolCallId: "call-hostile-input",
        toolInput: hostileInput,
      }),
    );

    // Then
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("tool_permission_evaluation_failed");
  });

  it("emits tool.execution.permission_denied event on deny", async () => {
    const events: Array<{ name: string; data: unknown }> = [];
    const mockEmitter: AgentEventEmitter = {
      emit: (name: string, data: unknown) => {
        events.push({ name, data });
      },
    };

    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", denylist: ["blocked_tool"] },
      eventEmitter: mockEmitter,
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "blocked_tool",
        toolCallId: "call-8",
        toolInput: {},
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(events.some((e) => e.name === "tool.execution.permission_denied")).toBe(true);
  });

  it("calls onToolBlocked callback on deny", async () => {
    let blocked: { toolCallId: string; toolName: string; reason: string } | undefined;
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", denylist: ["blocked_tool"] },
      onToolBlocked: (toolCallId, toolName, reason) => {
        blocked = { toolCallId, toolName, reason };
      },
    });
    await mw.fn(
      baseCtx({
        toolName: "blocked_tool",
        toolCallId: "call-9",
        toolInput: {},
      }),
    );
    expect(blocked).toBeDefined();
    expect(blocked?.toolName).toBe("blocked_tool");
    expect(blocked?.reason).toBe("denylist");
  });

  it("registers canonical metadata", () => {
    const mw = createToolPermissionPolicy({ permission: { action: "tool.call" } });
    expect(mw.name).toBe("builtin:tool-permission");
    expect(mw.pointIds).toEqual(["tool.native.pre", "tool.mcp.pre"]);
    expect(mw.priority).toBe(0);
    expect(mw.failPolicy).toBe("fail-closed");
  });

  it("abort — denyLabels match blocks tool", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", denyLabels: ["risk.tier-3"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "some_tool",
        toolCallId: "call-10",
        toolInput: {},
        toolLabels: ["risk.tier-3", "capability.write"],
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("deny_label");
  });

  it("continue — no permission rules means default allow", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call" },
    });
    const verdict = await mw.fn(
      baseCtx({
        toolName: "any_tool",
        toolCallId: "call-11",
        toolInput: {},
      }),
    );
    expect(verdict.verdict).toBe("allow");
    expect(verdict.reasonCodes).toContain("default_allow");
  });
});
