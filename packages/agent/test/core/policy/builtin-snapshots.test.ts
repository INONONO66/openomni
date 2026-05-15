import { afterEach, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { BudgetState } from "../../../src/core/budget";
import type { Memory, MemoryResult } from "../../../src/core/memory";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
} from "../../../src/core/policy/builtin/budget";
import { createToolPermissionPolicy } from "../../../src/core/policy/builtin/tool-guard";
import { createMemoryPolicy } from "../../../src/core/policy/builtin/memory";
import { createCompactionPolicy } from "../../../src/core/policy/builtin/compaction";
import { createPostToolPolicy } from "../../../src/core/policy/builtin/post-tool";
import { createPostTurnPolicy } from "../../../src/core/policy/builtin/post-turn";
import { createIdleNudgePolicy } from "../../../src/core/policy/builtin/idle-nudge";
import { createUserMessage } from "../../../src/core/message-factory";
import { abortRun, allow, effectOf, firstReason, inject } from "../../helpers/policy-decision";

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

function mockMemory(results: MemoryResult[] = []): Memory {
  return {
    store: async () => undefined,
    retrieve: async () => results,
    clear: async () => undefined,
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
      baseCtx({
        budgetState: budgetState({ turns: 5 }),
        budget: { maxTurns: 24 },
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("inject — at 0.6 threshold", async () => {
    const mw = createBudgetReassurancePolicy();
    const verdict = await mw.fn(
      baseCtx({
        budgetState: budgetState({ turns: 15 }),
        budget: { maxTurns: 24 },
      }),
    );
    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("budget_reassurance");
    expect(verdict.policyId).toBe("builtin.budget.reassurance");
    const effect = effectOf(verdict, "prompt.inject_message");
    expect(effect?.message).toContain("[Budget Status]");
    expect(effect?.message).toContain("Do NOT rush or skip tasks");
  });

  it("continue — fires only once (closure state)", async () => {
    const mw = createBudgetReassurancePolicy();
    const ctx = baseCtx({ budgetState: budgetState({ turns: 15 }), budget: { maxTurns: 24 } });
    await mw.fn(ctx);
    const second = await mw.fn(ctx);
    expect(second.verdict).toBe("allow");
  });

  it("continue — no budgetState", async () => {
    const mw = createBudgetReassurancePolicy();
    const verdict = await mw.fn(baseCtx());
    expect(verdict.verdict).toBe("allow");
  });
});

describe("snapshot: budget-warning", () => {
  it("continue — below 0.8 threshold", async () => {
    const mw = createBudgetWarningPolicy();
    const verdict = await mw.fn(
      baseCtx({
        budgetState: budgetState({ turns: 10 }),
        budget: { maxTurns: 24 },
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("inject — at 0.8 threshold", async () => {
    const mw = createBudgetWarningPolicy();
    const verdict = await mw.fn(
      baseCtx({
        budgetState: budgetState({ turns: 20 }),
        budget: { maxTurns: 24 },
      }),
    );
    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("budget_warning");
    expect(verdict.policyId).toBe("builtin.budget.warning");
    const effect = effectOf(verdict, "prompt.inject_message");
    expect(effect?.message).toContain("[Budget Warning]");
    expect(effect?.message).toContain("Wrap up your current task");
  });

  it("continue — fires only once", async () => {
    const mw = createBudgetWarningPolicy();
    const ctx = baseCtx({ budgetState: budgetState({ turns: 20 }), budget: { maxTurns: 24 } });
    await mw.fn(ctx);
    const second = await mw.fn(ctx);
    expect(second.verdict).toBe("allow");
  });

  it("continue — no budgetState", async () => {
    const mw = createBudgetWarningPolicy();
    const verdict = await mw.fn(baseCtx());
    expect(verdict.verdict).toBe("allow");
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

  it("abort — tool on denylist", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", denylist: ["dangerous_tool"] },
    });
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.prepare",
        toolName: "dangerous_tool",
        toolCallId: "call-3",
        toolInput: {},
      }),
    );
    expect(verdict.verdict).toBe("deny");
    expect(firstReason(verdict)).toBe("denylist");
  });

  it("continue — no toolName in context", async () => {
    const mw = createToolPermissionPolicy({
      permission: { action: "tool.call", allowlist: ["read_file"] },
    });
    const verdict = await mw.fn(baseCtx({ timing: "invoke.prepare" }));
    expect(verdict.verdict).toBe("allow");
  });
});

describe("snapshot: memory", () => {
  it("transform — memory results found", async () => {
    const results: MemoryResult[] = [
      { key: "k1", content: "user prefers dark mode", score: 0.9 },
      { key: "k2", content: "user timezone is KST", score: 0.8 },
    ];
    const mw = createMemoryPolicy(mockMemory(results));
    const userMsg = createUserMessage("what are my preferences?", "test");
    const verdict = await mw.fn(baseCtx({ timing: "context.prepare", messages: [userMsg] }));

    expect(verdict.verdict).toBe("allow");
    const effect = effectOf(verdict, "prompt.append_context");
    expect(effect?.context).toBe(
      "[Memory Context]\n- user prefers dark mode\n- user timezone is KST",
    );
    expect(firstReason(verdict)).toBe("memory_context_available");
    expect(verdict.policyId).toBe("builtin.memory");
  });

  it("continue — no memory results", async () => {
    const mw = createMemoryPolicy(mockMemory([]));
    const userMsg = createUserMessage("hello", "test");
    const verdict = await mw.fn(baseCtx({ timing: "context.prepare", messages: [userMsg] }));
    expect(verdict.verdict).toBe("allow");
  });

  it("continue — no messages in context", async () => {
    const mw = createMemoryPolicy(mockMemory([{ key: "k1", content: "data", score: 1.0 }]));
    const verdict = await mw.fn(baseCtx({ timing: "context.prepare" }));
    expect(verdict.verdict).toBe("allow");
  });

  it("continue — memory.retrieve throws", async () => {
    const mem = mockMemory();
    mem.retrieve = async () => {
      throw new Error("service down");
    };
    const mw = createMemoryPolicy(mem);
    const userMsg = createUserMessage("test", "test");
    const verdict = await mw.fn(baseCtx({ timing: "context.prepare", messages: [userMsg] }));
    expect(verdict.verdict).toBe("allow");
  });
});

describe("snapshot: compaction", () => {
  it("continue — below token threshold", async () => {
    const mw = createCompactionPolicy({ contextWindowTokens: 10000, thresholdRatio: 0.8 });
    const messages = [testMessage("m1"), testMessage("m2")];
    const verdict = await mw.fn(
      baseCtx({
        messages,
        budgetState: budgetState({ totalInputTokens: 1000, totalOutputTokens: 500 }),
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("transform — above token threshold", async () => {
    const mw = createCompactionPolicy({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
      protectRecentMessages: 2,
    });
    const messages = Array.from({ length: 10 }, (_, i) => testMessage(`m${i}`));
    const verdict = await mw.fn(
      baseCtx({
        messages,
        budgetState: budgetState({ totalInputTokens: 7000, totalOutputTokens: 1000 }),
      }),
    );
    expect(verdict.verdict).toBe("allow");
    expect(firstReason(verdict)).toBe("compaction_threshold_exceeded");
    expect(verdict.policyId).toBe("builtin.compaction");
    const effect = effectOf(verdict, "run.replace_messages");
    expect(effect?.messages.length).toBeLessThan(messages.length);
  });

  it("continue — no budgetState", async () => {
    const mw = createCompactionPolicy({ contextWindowTokens: 1000, thresholdRatio: 0.8 });
    const messages = Array.from({ length: 10 }, (_, i) => testMessage(`m${i}`));
    const verdict = await mw.fn(baseCtx({ messages }));
    expect(verdict.verdict).toBe("allow");
  });

  it("continue — empty messages", async () => {
    const mw = createCompactionPolicy({ contextWindowTokens: 1000, thresholdRatio: 0.8 });
    const verdict = await mw.fn(
      baseCtx({
        messages: [],
        budgetState: budgetState({ totalInputTokens: 9000, totalOutputTokens: 1000 }),
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });
});

describe("snapshot: post-tool", () => {
  it("transform — enricher returns string, appended to existing output", async () => {
    const mw = createPostToolPolicy(() => "enrichment");
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.result",
        toolName: "read_file",
        toolCallId: "call-1",
        toolOutput: "file contents here",
      }),
    );
    expect(verdict.verdict).toBe("allow");
    const effect = effectOf(verdict, "tool.rewrite_output");
    expect(effect?.output).toBe("file contents here\nenrichment");
    expect(firstReason(verdict)).toBe("post_tool_enrichment");
    expect(verdict.policyId).toBe("builtin.post_tool");
  });

  it("continue — enricher returns null", async () => {
    const mw = createPostToolPolicy(() => null);
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.result",
        toolName: "read_file",
        toolOutput: "content",
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("continue — enricher throws (error isolation)", async () => {
    const mw = createPostToolPolicy(() => {
      throw new Error("enricher boom");
    });
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.result",
        toolName: "test-tool",
        toolOutput: "content",
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("transform — empty toolOutput uses enrichment only", async () => {
    const mw = createPostToolPolicy(() => "standalone enrichment");
    const verdict = await mw.fn(
      baseCtx({
        timing: "invoke.result",
        toolName: "test-tool",
        toolOutput: "",
      }),
    );
    expect(verdict.verdict).toBe("allow");
    const effect = effectOf(verdict, "tool.rewrite_output");
    expect(effect?.output).toBe("standalone enrichment");
  });
});

describe("snapshot: post-turn", () => {
  it("inject — handler returns inject verdict", async () => {
    const mw = createPostTurnPolicy(() =>
      inject("reminder to user", "test.turn.finish", "turn_reminder"),
    );
    const verdict = await mw.fn(baseCtx({ timing: "turn.finish", turnCount: 3 }));
    expect(verdict.verdict).toBe("allow");
    expect(effectOf(verdict, "prompt.inject_message")?.message).toBe("reminder to user");
    expect(firstReason(verdict)).toBe("turn_reminder");
  });

  it("continue — handler returns continue", async () => {
    const mw = createPostTurnPolicy(() => allow("test.turn.finish"));
    const verdict = await mw.fn(baseCtx({ timing: "turn.finish", turnCount: 1 }));
    expect(verdict.verdict).toBe("allow");
  });

  it("abort — handler returns abort", async () => {
    const mw = createPostTurnPolicy(() => abortRun("test.turn.finish", "max_turns_reached"));
    const verdict = await mw.fn(baseCtx({ timing: "turn.finish", turnCount: 10 }));
    expect(verdict.verdict).toBe("deny");
    expect(firstReason(verdict)).toBe("max_turns_reached");
  });

  it("continue — handler throws (error isolation)", async () => {
    const mw = createPostTurnPolicy(() => {
      throw new Error("handler exploded");
    });
    const verdict = await mw.fn(baseCtx({ timing: "turn.finish", turnCount: 1 }));
    expect(verdict.verdict).toBe("allow");
  });
});

describe("snapshot: idle-nudge", () => {
  it("continue — activity is recent", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(30000);
    const verdict = await mw.fn(baseCtx({ timing: "turn.start" }));
    expect(verdict.verdict).toBe("allow");
  });

  it("inject — idle threshold exceeded", async () => {
    mockNow(1000);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(70000);
    const verdict = await mw.fn(baseCtx({ timing: "turn.start" }));
    expect(verdict.verdict).toBe("allow");
    const effect = effectOf(verdict, "prompt.inject_message");
    expect(effect?.message).toContain("[System]");
    expect(effect?.message).toContain("idle for 69s");
    expect(firstReason(verdict)).toBe("idle_nudge");
    expect(verdict.policyId).toBe("builtin.idle_nudge");
  });

  it("abort — maxNudges exceeded", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 1000, maxNudges: 2 });
    mockNow(2000);
    await mw.fn(baseCtx({ timing: "turn.start" }));
    mockNow(4000);
    await mw.fn(baseCtx({ timing: "turn.start" }));
    mockNow(6000);
    const verdict = await mw.fn(baseCtx({ timing: "turn.start" }));
    expect(verdict.verdict).toBe("deny");
    expect(firstReason(verdict)).toBe("stalled");
    expect(verdict.policyId).toBe("builtin.idle_nudge");
  });

  it("continue — invoke.result resets idle timer", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: 60000 });
    mockNow(65000);
    await mw.fn(baseCtx({ timing: "invoke.result" }));
    mockNow(70000);
    const verdict = await mw.fn(baseCtx({ timing: "turn.start" }));
    expect(verdict.verdict).toBe("allow");
  });

  it("continue — disabled when idleThresholdMs is -1", async () => {
    mockNow(0);
    const mw = createIdleNudgePolicy({ idleThresholdMs: -1 });
    mockNow(999999);
    const verdict = await mw.fn(baseCtx({ timing: "turn.start" }));
    expect(verdict.verdict).toBe("allow");
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

  it("memory: name, timing, priority", () => {
    const mw = createMemoryPolicy(mockMemory());
    expect(mw.name).toBe("builtin:memory");
    expect(mw.timing).toBe("context.prepare");
    expect(mw.priority).toBe(100);
  });

  it("compaction: name, timing, priority", () => {
    const mw = createCompactionPolicy({ contextWindowTokens: 1000 });
    expect(mw.name).toBe("builtin:compaction");
    expect(mw.timing).toBe("completion.prepare");
    expect(mw.priority).toBe(900);
  });

  it("post-tool: name, timing, priority", () => {
    const mw = createPostToolPolicy(() => null);
    expect(mw.name).toBe("builtin:post-tool");
    expect(mw.timing).toBe("invoke.result");
    expect(mw.priority).toBe(200);
  });

  it("post-turn: name, timing, priority", () => {
    const mw = createPostTurnPolicy(() => allow("test.turn.finish"));
    expect(mw.name).toBe("builtin:post-turn");
    expect(mw.timing).toBe("turn.finish");
    expect(mw.priority).toBe(250);
  });

  it("idle-nudge: name, timing (array), priority", () => {
    const mw = createIdleNudgePolicy();
    expect(mw.name).toBe("builtin:idle-nudge");
    expect(mw.timing).toEqual(["turn.start", "invoke.result"]);
    expect(mw.priority).toBe(300);
  });
});
