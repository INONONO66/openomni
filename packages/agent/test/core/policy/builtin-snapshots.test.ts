import { afterEach, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import type { BudgetState } from "../../../src/core/budget";
import type { PolicyContext } from "../../../src/core/policy/types";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
} from "../../../src/core/policy/builtin/budget";
import { createCompactionPolicy } from "../../../src/core/policy/builtin/compaction";
import { createIdleNudgePolicy } from "../../../src/core/policy/builtin/idle-nudge";
import { createToolPermissionPolicy } from "../../../src/core/policy/builtin/tool-guard";
import { effectOf, firstReason } from "../../helpers/policy-decision";

function baseCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    timing: "turn.start",
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
      permission: { action: "tool.call", allowlist: ["read_file", "write_file"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.prepare",
        toolName: "read_file",
        toolCallId: "call-1",
        toolInput: { path: "/tmp/test" },
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("abort — tool not on allowlist", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", allowlist: ["read_file"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.prepare",
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
    const mw = createCompactionPolicy({ contextWindowTokens: 10000, thresholdRatio: 0.8 });
    const verdict = await mw.fn(
      baseCtx({
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

describe("snapshot: registration metadata", () => {
  it("budget-reassurance: name, timing, priority", () => {
    const mw = createBudgetReassurancePolicy();
    expect(mw.name).toBe("builtin:budget-reassurance");
    expect(mw.timing).toBe("turn.start");
    expect(mw.priority).toBe(10);
  });

  it("budget-warning: name, timing, priority", () => {
    const mw = createBudgetWarningPolicy();
    expect(mw.name).toBe("builtin:budget-warning");
    expect(mw.timing).toBe("turn.start");
    expect(mw.priority).toBe(20);
  });

  it("tool-permission: name, timing, priority, failPolicy", () => {
    const mw = createToolPermissionPolicy({ permission: { action: "tool.call" } });
    expect(mw.name).toBe("builtin:tool-permission");
    expect(mw.timing).toBe("invoke.prepare");
    expect(mw.priority).toBe(0);
    expect(mw.failPolicy).toBe("fail-closed");
  });

  it("compaction: name, timing, priority", () => {
    const mw = createCompactionPolicy({ contextWindowTokens: 1000 });
    expect(mw.name).toBe("builtin:compaction");
    expect(mw.timing).toBe("completion.prepare");
    expect(mw.priority).toBe(900);
  });

  it("idle-nudge: name, timing (array), priority", () => {
    const mw = createIdleNudgePolicy();
    expect(mw.name).toBe("builtin:idle-nudge");
    expect(mw.timing).toEqual(["turn.start", "invoke.result"]);
    expect(mw.priority).toBe(300);
  });
});
