import { afterEach, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import type { BudgetState } from "../../../src/core/budget";
import type { PolicyFn } from "../../../src/core/policy";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
} from "../../../src/core/policy/builtin/budget";
import { createCompactionPolicy } from "../../../src/core/policy/builtin/compaction";
import { createIdleNudgePolicy } from "../../../src/core/policy/builtin/idle-nudge";
import { createToolPermissionPolicy } from "../../../src/core/policy/builtin/tool-guard";
import { effectOf, firstReason } from "../../helpers/policy-decision";
import { Bus } from "@openomni/telemetry";

function baseCtx(overrides?: Partial<Parameters<PolicyFn>[0]>): Parameters<PolicyFn>[0] {
  return {
    timing: "turn.start",
    pointId: "run.turn.pre",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function budgetState(overrides?: Partial<BudgetState>): BudgetState {
  return {
    startTime: Date.now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  };
}

function testMessage(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "test-session",
      role: "user" as const,
      time: { created: Date.now() },
      agent: "test-agent",
      model: { providerID: "test", modelID: "test" },
      system: `Test message ${id}`,
    },
    parts: [
      {
        id: `part-${id}`,
        sessionID: "test-session",
        messageID: id,
        type: "text" as const,
        text: `Test message ${id}`,
      },
    ],
  };
}

const originalNow = Date.now;
function mockNow(ms: number): void {
  Date.now = () => ms;
}

afterEach(() => {
  Date.now = originalNow;
});

describe("snapshot: budget-reassurance", () => {
  it("continue — below 0.6 threshold", async () => {
    const mw = createBudgetReassurancePolicy();
    const verdict = await mw.fn(
      baseCtx({ budgetState: budgetState({ turns: 5 }), budget: { maxTurns: 24 } }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("inject — at 0.6 threshold", async () => {
    const mw = createBudgetReassurancePolicy();
    const verdict = await mw.fn(
      baseCtx({ budgetState: budgetState({ turns: 15 }), budget: { maxTurns: 24 } }),
    );
    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("budget_reassurance");
    expect(verdict.policyId).toBe("builtin.budget.reassurance");
    expect(effectOf(verdict, "prompt.inject_message")?.message).toContain("[Budget Status]");
  });
});

describe("snapshot: budget-warning", () => {
  it("continue — below 0.8 threshold", async () => {
    const mw = createBudgetWarningPolicy();
    const verdict = await mw.fn(
      baseCtx({ budgetState: budgetState({ turns: 10 }), budget: { maxTurns: 24 } }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("inject — at 0.8 threshold", async () => {
    const mw = createBudgetWarningPolicy();
    const verdict = await mw.fn(
      baseCtx({ budgetState: budgetState({ turns: 20 }), budget: { maxTurns: 24 } }),
    );
    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("budget_warning");
    expect(verdict.policyId).toBe("builtin.budget.warning");
    expect(effectOf(verdict, "prompt.inject_message")?.message).toContain("[Budget Warning]");
  });
});

describe("snapshot: tool-permission", () => {
  it("continue — tool on allowlist", async () => {
    const mw = createToolPermissionPolicy({
      events: Bus,
      permission: { action: "tool.call", allowlist: ["read_file", "write_file"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.prepare",
        pointId: "tool.native.pre",
        toolName: "read_file",
        toolCallId: "call-1",
        toolInput: { path: "/tmp/test" },
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("abort — tool not on allowlist", async () => {
    const mw = createToolPermissionPolicy({
      events: Bus,
      permission: { action: "tool.call", allowlist: ["read_file"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.prepare",
        pointId: "tool.native.pre",
        toolName: "shell_exec",
        toolCallId: "call-2",
        toolInput: { cmd: "rm -rf /" },
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(firstReason(verdict)).toBe("allowlist_miss");
    expect(verdict.policyId).toBe("guardrail.permission");
  });
});

describe("snapshot: compaction", () => {
  it("continue — below token threshold", async () => {
    const mw = createCompactionPolicy({
      events: Bus,
      contextWindowTokens: 10000,
      thresholdRatio: 0.8,
    });
    const verdict = await mw.fn(
      baseCtx({
        pointId: "run.completion.pre",
        messages: [testMessage("m1"), testMessage("m2")],
        budgetState: budgetState({ totalInputTokens: 1000, totalOutputTokens: 500 }),
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });
});

describe("snapshot: idle-nudge", () => {
  it("inject — idle threshold exceeded", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(70000);
    const verdict = await mw.fn(baseCtx({ timing: "turn.start" }));
    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("idle_nudge");
    expect(verdict.policyId).toBe("builtin.idle_nudge");
  });
});

describe("snapshot: canonical registration metadata", () => {
  it("budget-reassurance: name, point, priority", () => {
    const mw = createBudgetReassurancePolicy();
    expect(mw.name).toBe("builtin:budget-reassurance");
    expect(mw.pointIds).toEqual(["run.turn.pre"]);
    expect(mw.effectCapabilities).toEqual({
      "run.turn.pre": ["prompt.inject_message"],
    });
    expect(mw.priority).toBe(10);
  });

  it("budget-warning: name, point, priority", () => {
    const mw = createBudgetWarningPolicy();
    expect(mw.name).toBe("builtin:budget-warning");
    expect(mw.pointIds).toEqual(["run.turn.pre"]);
    expect(mw.effectCapabilities).toEqual({
      "run.turn.pre": ["prompt.inject_message"],
    });
    expect(mw.priority).toBe(20);
  });

  it("tool-permission: name, points, priority, failPolicy", () => {
    const mw = createToolPermissionPolicy({ events: Bus, permission: { action: "tool.call" } });
    expect(mw.name).toBe("builtin:tool-permission");
    expect(mw.pointIds).toEqual(["tool.native.pre", "tool.mcp.pre"]);
    expect(mw.effectCapabilities).toEqual({
      "tool.native.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
      "tool.mcp.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
    });
    expect(mw.priority).toBe(0);
    expect(mw.failPolicy).toBe("fail-closed");
  });

  it("compaction: name, point, priority", () => {
    const mw = createCompactionPolicy({ events: Bus, contextWindowTokens: 1000 });
    expect(mw.name).toBe("builtin:compaction");
    expect(mw.pointIds).toEqual(["run.completion.pre"]);
    expect(mw.effectCapabilities).toEqual({
      "run.completion.pre": ["run.replace_messages"],
    });
    expect(mw.priority).toBe(900);
  });

  it("idle-nudge: name, points, priority", () => {
    const mw = createIdleNudgePolicy();
    expect(mw.name).toBe("builtin:idle-nudge");
    expect(mw.pointIds).toEqual(["run.turn.pre", "tool.native.post", "tool.mcp.post"]);
    expect(mw.effectCapabilities).toEqual({
      "run.turn.pre": ["prompt.inject_message", "run.abort"],
      "tool.native.post": [],
      "tool.mcp.post": [],
    });
    expect(mw.priority).toBe(300);
  });
});
