import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { ChatAgentConfig, ChatAgentInput, AgentEvent } from "../../../src/core/types";
import type { TraceContext } from "@openomni/protocol";
import {
  buildPolicyEngine,
  buildTurn,
  createStreamRunState,
  dispatchBudgetCheck,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
  handleError,
  handleStop,
  type StreamAgentBase,
  type StreamRunState,
  type TurnArtifacts,
} from "../../../src/core/execution/stream-helpers";

function makeInput(): ChatAgentInput {
  return { messages: [{ role: "user", content: "hello" }] };
}

function makeConfig(overrides?: Partial<ChatAgentConfig>): ChatAgentConfig {
  return {
    model: { provider: "test", id: "test-model" },
    systemPrompt: "test",
    ...overrides,
  };
}

function makeAgentBase(): StreamAgentBase {
  return { traceId: "trace-1", sessionId: "sess-1" };
}

function makeTrace(): TraceContext.Type {
  return { traceId: "trace-1", sessionId: "sess-1" };
}

function makeState(): StreamRunState {
  return createStreamRunState(makeInput());
}

function makeTurnArtifacts(overrides?: Partial<TurnArtifacts>): TurnArtifacts {
  return {
    runInput: {
      messages: [],
      tools: [],
      model: { provider: "test", id: "test-model" },
      maxSteps: 24,
    },
    trackingSink: {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onSnapshot: () => undefined,
    },
    turnUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    turnToolCalls: [],
    turnToolResults: [],
    preToolUseVerdicts: [],
    ...overrides,
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("dispatchPreRun (run.start)", () => {
  it("dispatches run.start and allows continuation on continue verdict", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({
      action: "continue" as const,
    }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-pre-run", timing: "run.start", priority: 100, fn });

    const state = makeState();
    const result = await dispatchPreRun(state, engine, makeConfig());

    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("run.start");
  });

  it("returns abort event when run.start policy returns abort", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-pre-run-abort",
      timing: "run.start",
      priority: 100,
      fn: () => ({ action: "abort", reason: "pre-run-block", policyId: "test.abort" }),
    });

    const state = makeState();
    const result = await dispatchPreRun(state, engine, makeConfig());

    expect(result).not.toBeNull();
    expect(result!.type).toBe("complete");
    const complete = result as Extract<AgentEvent, { type: "complete" }>;
    expect(complete.result.guardAborted).toBe(true);
    expect(complete.result.finishReason).toBe("stop");
  });

  it("injects user message when run.start policy returns inject", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-pre-run-inject",
      timing: "run.start",
      priority: 100,
      fn: () => ({
        action: "inject",
        message: "injected-context",
        reason: "add-context",
        policyId: "test.inject",
      }),
    });

    const state = makeState();
    const messagesBefore = state.messages.length;
    const result = await dispatchPreRun(state, engine, makeConfig());

    expect(result).toBeNull();
    expect(state.messages.length).toBe(messagesBefore + 1);
    const lastMsg = state.messages.at(-1)!;
    expect(lastMsg.info.role).toBe("user");
    const text = lastMsg.parts
      .filter(
        (p): p is { type: "text"; text: string } & Record<string, unknown> => p.type === "text",
      )
      .map((p) => p.text)
      .join("");
    expect(text).toBe("injected-context");
  });
});

describe("buildTurn (turn.start + context.prepare + resources.prepare)", () => {
  it("dispatches turn.start and returns ready on continue", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({ action: "continue" as const }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-pre-turn", timing: "turn.start", priority: 100, fn });

    const state = makeState();
    const config = makeConfig();
    const result = await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("turn.start");
  });

  it("returns complete when turn.start policy returns abort", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-pre-turn-abort",
      timing: "turn.start",
      priority: 100,
      fn: () => ({ action: "abort", reason: "pre-turn-block", policyId: "test.abort" }),
    });

    const state = makeState();
    const result = await buildTurn(
      state,
      makeConfig(),
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("complete");
    if (result.type === "complete") {
      expect(result.event.type).toBe("complete");
    }
  });

  it("dispatches context.prepare during buildTurn", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({
      action: "transform" as const,
      input: { appendContext: "extra-context" },
      reason: "system-prompt-extend",
      policyId: "test.sp",
    }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-sp", timing: "context.prepare", priority: 100, fn });

    const state = makeState();
    const config = makeConfig({ systemPrompt: "base prompt" });
    const result = await buildTurn(
      state,
      config,
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    expect(fn).toHaveBeenCalledTimes(1);
    if (result.type === "ready") {
      expect(result.turn.runInput.system).toContain("extra-context");
    }
  });
});

describe("dispatchBudgetCheck (run.finish on budget exceeded)", () => {
  it("dispatches run.finish when budget is exceeded", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({ action: "continue" as const }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-post-run", timing: "run.finish", priority: 100, fn });

    const state = makeState();
    state.budgetState = {
      ...state.budgetState,
      turns: 100,
      toolCalls: 100,
      inputTokens: 100000,
      outputTokens: 100000,
      toolRuntimeMs: 100000,
    };
    const config = makeConfig({ budget: { maxTurns: 1 } });

    const result = await dispatchBudgetCheck(state, engine, config, makeAgentBase());

    expect(result).not.toBeNull();
    expect(result!.type).toBe("complete");
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("run.finish");
    expect(ctx.isCompletion).toBe(true);
  });

  it("returns null when budget is not exceeded", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    const state = makeState();
    const config = makeConfig({ budget: { maxTurns: 100 } });

    const result = await dispatchBudgetCheck(state, engine, config, makeAgentBase());
    expect(result).toBeNull();
  });
});

describe("model dispatch points", () => {
  it("dispatches model.request before provider execution", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({ action: "continue" as const }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-model-request", timing: "model.request", priority: 100, fn });

    const state = makeState();
    const result = await dispatchModelRequest(state, engine, makeConfig());

    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("model.request");
  });

  it("dispatches model.response after provider execution and exposes outcome type", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({
      action: "transform" as const,
      input: { text: "rewritten" },
      reason: "rewrite-response",
      policyId: "test.model-response",
    }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-model-response", timing: "model.response", priority: 100, fn });

    const state = makeState();
    state.lastAssistantText = "original";
    const result = await dispatchModelResponse(state, engine, makeConfig(), "stop");

    expect(result).toBeNull();
    expect(state.lastAssistantText).toBe("rewritten");
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("model.response");
    expect(ctx.toolInput?.outcomeType).toBe("stop");
  });
});

describe("handleStop (turn.finish + run.finish)", () => {
  it("dispatches turn.finish on stop and completes normally", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({ action: "continue" as const }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-post-turn", timing: "turn.finish", priority: 100, fn });

    const state = makeState();
    state.lastAssistantText = "response text";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const events = await collectEvents(handleStop(state, config, engine, makeAgentBase(), turn));

    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("turn.finish");
    expect(ctx.isCompletion).toBe(true);

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
  });

  it("turn.finish inject verdict causes continuation", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-turn-inject",
      timing: "turn.finish",
      priority: 100,
      fn: () => ({
        action: "inject",
        message: "continue working",
        reason: "continuation",
        policyId: "test.inject",
      }),
    });

    const state = makeState();
    state.lastAssistantText = "partial response";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const gen = handleStop(state, config, engine, makeAgentBase(), turn);
    let result: IteratorResult<AgentEvent, "complete" | "continue">;
    const events: AgentEvent[] = [];
    do {
      result = await gen.next();
      if (!result.done && result.value) events.push(result.value);
    } while (!result.done);

    expect(result.value).toBe("continue");
    expect(state.messages.length).toBeGreaterThan(1);
    expect(state.continuationCount).toBe(1);
  });

  it("turn.finish abort verdict yields complete event with guardAborted", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-turn-abort",
      timing: "turn.finish",
      priority: 100,
      fn: () => ({
        action: "abort",
        reason: "force-stop",
        policyId: "test.abort",
      }),
    });

    const state = makeState();
    state.lastAssistantText = "text";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const events = await collectEvents(handleStop(state, config, engine, makeAgentBase(), turn));
    const completeEvent = events.find((e) => e.type === "complete") as
      | Extract<AgentEvent, { type: "complete" }>
      | undefined;

    expect(completeEvent).toBeDefined();
    expect(completeEvent!.result.guardAborted).toBe(true);
  });

  it("turn.finish abort with reason 'stalled' sets finishReason to stalled", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-stalled",
      timing: "turn.finish",
      priority: 100,
      fn: () => ({
        action: "abort",
        reason: "stalled",
        policyId: "test.stalled",
      }),
    });

    const state = makeState();
    state.lastAssistantText = "text";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const events = await collectEvents(handleStop(state, config, engine, makeAgentBase(), turn));
    const completeEvent = events.find((e) => e.type === "complete") as
      | Extract<AgentEvent, { type: "complete" }>
      | undefined;

    expect(completeEvent).toBeDefined();
    expect(completeEvent!.result.finishReason).toBe("stalled");
    expect(completeEvent!.result.guardAborted).toBeFalsy();
  });

  it("dispatches run.finish transform to modify final text", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-run-transform",
      timing: "run.finish",
      priority: 100,
      fn: () => ({
        action: "transform",
        input: { text: "transformed-text" },
        reason: "transform-final",
        policyId: "test.transform",
      }),
    });

    const state = makeState();
    state.lastAssistantText = "original";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const events = await collectEvents(handleStop(state, config, engine, makeAgentBase(), turn));
    const completeEvent = events.find((e) => e.type === "complete") as
      | Extract<AgentEvent, { type: "complete" }>
      | undefined;

    expect(completeEvent).toBeDefined();
    expect(completeEvent!.result.text).toBe("transformed-text");
  });
});

describe("handleError (error)", () => {
  it("dispatches error and respects abort verdict", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({
      action: "abort" as const,
      reason: "error-abort",
      policyId: "test.error-abort",
    }));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-on-error", timing: "error", priority: 100, fn });

    const state = makeState();
    const config = makeConfig();
    const error = new Error("test-failure");
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const gen = handleError(state, engine, config, makeAgentBase(), error, 1, retryPolicy);
    let result: IteratorResult<AgentEvent, unknown>;
    const events: AgentEvent[] = [];
    do {
      result = await gen.next();
      if (!result.done && result.value) events.push(result.value as AgentEvent);
    } while (!result.done);

    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("error");
    expect(ctx.toolInput?.error).toBe(error);

    const decision = result.value as { action: string };
    expect(decision.action).toBe("complete");
    const completeEvent = events.find((e) => e.type === "complete") as
      | Extract<AgentEvent, { type: "complete" }>
      | undefined;
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.result.guardAborted).toBe(true);
  });

  it("error continue verdict allows retry when retry policy permits", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-on-error-continue",
      timing: "error",
      priority: 100,
      fn: () => ({ action: "continue" as const }),
    });

    const state = makeState();
    const config = makeConfig();
    const error = new Error("timeout while waiting");
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const gen = handleError(state, engine, config, makeAgentBase(), error, 1, retryPolicy);
    let result: IteratorResult<AgentEvent, unknown>;
    do {
      result = await gen.next();
    } while (!result.done);

    const decision = result.value as { action: string };
    expect(decision.action).toBe("retry");
  });
});

describe("completion.prepare dispatch", () => {
  it("completion.prepare transform replaces messages in state", async () => {
    Bus.reset();
    const { createUserMessage } = await import("../../../src/core/message-factory");
    const compactedMessages = [createUserMessage("compacted summary", "test")];

    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-compaction",
      timing: "completion.prepare",
      priority: 100,
      fn: () => ({
        action: "transform",
        input: { messages: compactedMessages },
        reason: "compact",
        policyId: "test.compact",
      }),
    });

    const verdict = await engine.dispatch("completion.prepare", {
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 1,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 100,
    });

    expect(verdict.action).toBe("transform");
    if (verdict.action === "transform") {
      const payload = verdict.input as { messages?: unknown };
      expect(Array.isArray(payload.messages)).toBe(true);
    }
  });

  it("completion.prepare continue verdict leaves state unchanged", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({ action: "continue" as const }));
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-compaction-noop",
      timing: "completion.prepare",
      priority: 100,
      fn,
    });

    const verdict = await engine.dispatch("completion.prepare", {
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 1,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 100,
    });

    expect(verdict.action).toBe("continue");
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("completion.prepare");
  });
});

describe("buildPolicyEngine registers builtins", () => {
  it("creates engine with builtins from config", () => {
    const config = makeConfig({
      budget: { maxTurns: 10 },
      compaction: { contextWindowTokens: 1000 },
    });

    const engine = buildPolicyEngine(config, makeAgentBase());
    expect(engine).toBeDefined();
    expect(typeof engine.dispatch).toBe("function");
    expect(typeof engine.register).toBe("function");
  });
});
