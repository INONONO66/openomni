import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createToolPermissionPolicy } from "../../src/execution-runtime/middleware/tool-permission-policy";
import type { PolicyFn } from "@openomni/agent";

function baseCtx(
  overrides?: Partial<Omit<Parameters<PolicyFn>[0], "pointId">>,
): Parameters<PolicyFn>[0] {
  return {
    timing: "invoke.prepare",
    pointId: "tool.native.pre",
    traceContext: { traceId: "trace-builtin-test" },
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
  /**
   * The guard evaluates inside a tool call inside a run — never an origin.
   */
  it("reports an evaluation failure under the run's trace", async () => {
    const seen: Array<{ traceId: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Debug, (event) => {
      seen.push(event as unknown as { traceId: string });
    });
    const hostileInput = new Proxy<Record<string, unknown>>(
      {},
      {
        get: () => {
          throw new Error("hostile tool input");
        },
      },
    );
    const mw = createToolPermissionPolicy({
      events: Bus,
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

    try {
      await mw.fn(
        baseCtx({
          traceContext: { traceId: "trace-guard-report" },
          toolName: "shell_exec",
          toolCallId: "call-reported",
          toolInput: hostileInput,
        }),
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(seen.filter((event) => event.traceId === "trace-guard-report")).toHaveLength(1);
  });

  it("refuses to report an evaluation failure without the run trace", async () => {
    const hostileInput = new Proxy<Record<string, unknown>>(
      {},
      {
        get: () => {
          throw new Error("hostile tool input");
        },
      },
    );
    const mw = createToolPermissionPolicy({
      events: Bus,
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

    for (const traceContext of [undefined, { traceId: "" }]) {
      await expect(
        mw.fn(
          baseCtx({
            traceContext,
            toolName: "shell_exec",
            toolCallId: "call-traceless",
            toolInput: hostileInput,
          }),
        ),
      ).rejects.toThrow("tool permission guard requires the run trace context");
    }
  });
  it("continue — tool on allowlist", async () => {
    const mw = createToolPermissionPolicy({
      events: Bus,
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
      events: Bus,
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
      events: Bus,
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
      events: Bus,
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

  it("abort — no toolName in context fails closed (audit batch A)", async () => {
    const mw = createToolPermissionPolicy({
      events: Bus,
      permission: { action: "tool.call", allowlist: ["read_file"] },
    });
    const verdict = await mw.fn(baseCtx());
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("tool_permission_missing_tool_name");
    expect(verdict.effects).toContainEqual({
      type: "run.abort",
      reason: "tool_permission_missing_tool_name",
    });
  });

  it("continue — wildcard allowlist allows everything", async () => {
    const mw = createToolPermissionPolicy({
      events: Bus,
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
      events: Bus,
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
      events: Bus,
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
      events: Bus,
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

  it("registers canonical metadata", () => {
    const mw = createToolPermissionPolicy({ events: Bus, permission: { action: "tool.call" } });
    expect(mw.name).toBe("builtin:tool-permission");
    expect(mw.pointIds).toEqual(["tool.native.pre", "tool.mcp.pre"]);
    expect(mw.priority).toBe(0);
    expect(mw.failPolicy).toBe("fail-closed");
    // Not decoration: the engine replaces any effect a registration did not
    // declare for the point it fired at, so an emptied entry would drop the
    // abort and the approval request at runtime while every direct
    // `mw.fn(ctx)` assertion here still passed.
    expect(mw.effectCapabilities).toEqual({
      "tool.native.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
      "tool.mcp.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
    });
  });

  it("abort — denyLabels match blocks tool", async () => {
    const mw = createToolPermissionPolicy({
      events: Bus,
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
      events: Bus,
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

/**
 * The ruleset-to-verdict mapping for approval. The executor's half — that a
 * pending decision blocks the call — is `agent`'s
 * `tool-executor-verdicts.test.ts`; that a `requireApproval` entry *produces*
 * one is this policy's, and was covered only by the integration suite #629
 * decomposed.
 */
describe("approval requirements", () => {
  it("returns pending with a require_approval effect", async () => {
    const mw = createToolPermissionPolicy({
      events: Bus,
      permission: { action: "tool.call", requireApproval: ["bash"] },
    });
    const verdict = await mw.fn(
      baseCtx({ toolName: "bash", toolCallId: "call-approval", toolInput: { cmd: "ls" } }),
    );
    expect(verdict.verdict).toBe("pending");
    expect(verdict.effects.map((effect) => effect.type)).toContain("tool.require_approval");
  });
});
