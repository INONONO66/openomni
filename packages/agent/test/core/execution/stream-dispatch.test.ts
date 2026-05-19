import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { ChatAgentConfig, ChatAgentInput, AgentEvent } from "../../../src/core/types";
import { Operational, type TraceContext } from "@openomni/protocol";
import {
  abortRun,
  allow,
  appendContext,
  inject,
  replaceMessages,
  replacePrompt,
  rewriteWriteback,
} from "../../helpers/policy-decision";
import { buildPolicyEngine } from "../../../src/core/execution/stream-policy-engine";
import { buildTurn } from "../../../src/core/execution/stream-turn";
import {
  createStreamRunState,
  type StreamAgentBase,
  type StreamRunState,
  type TurnArtifacts,
} from "../../../src/core/execution/stream-state";
import {
  dispatchBudgetCheck,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
} from "../../../src/core/execution/stream-policy-dispatch";
import { dispatchWritebackCommit } from "../../../src/core/execution/stream-writeback-policy";
import { handleCompact, handleError, handleStop } from "../../../src/core/execution/stream-flow";

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
    toolPolicyDecisions: [],
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
    const fn = mock((_ctx: PolicyContext) => allow());
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
      fn: () => abortRun("test.abort", "pre-run-block"),
    });

    const state = makeState();
    const result = await dispatchPreRun(state, engine, makeConfig());

    expect(result).not.toBeNull();
    expect(result?.type).toBe("complete");
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
      fn: () => inject("injected-context", "test.inject", "add-context"),
    });

    const state = makeState();
    const messagesBefore = state.messages.length;
    const result = await dispatchPreRun(state, engine, makeConfig());

    expect(result).toBeNull();
    expect(state.messages.length).toBe(messagesBefore + 1);
    const lastMsg = state.messages.at(-1);
    if (!lastMsg) throw new Error("expected injected message");
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

it("appends run.start context as a user message", async () => {
  Bus.reset();
  const engine = PolicyEngine.create();
  engine.register({
    name: "test-pre-run-context",
    timing: "run.start",
    priority: 100,
    fn: () => appendContext("run context", "test.context", "append"),
  });

  const state = makeState();
  const result = await dispatchPreRun(state, engine, makeConfig());

  expect(result).toBeNull();
  expect(state.messages.at(-1)?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "run context" }),
  );
});

describe("buildTurn (turn.start + context.prepare + resources.prepare)", () => {
  it("dispatches turn.start and returns ready on continue", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
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

  it("buildTurn emits budget_reassurance event when reasonCodes includes budget_reassurance", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-budget-reassurance",
      timing: "turn.start",
      priority: 100,
      fn: () =>
        allow("test-budget-reassurance", "budget_reassurance", [
          { type: "prompt.inject_message", message: "you are on track" },
        ]),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.budgetReassuranceEvent?.type).toBe("budget_reassurance");
      expect(result.budgetWarningEvent).toBeUndefined();
    }
  });

  it("buildTurn emits budget_warning event when reasonCodes includes budget_warning", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-budget-warning",
      timing: "turn.start",
      priority: 100,
      fn: () =>
        allow("test-budget-warning", "budget_warning", [
          { type: "prompt.inject_message", message: "finish this section soon" },
        ]),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.budgetWarningEvent?.type).toBe("budget_warning");
      expect(result.budgetReassuranceEvent).toBeUndefined();
    }
  });

  it("buildTurn does not emit budget events for unrelated inject messages", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-unrelated-inject",
      timing: "turn.start",
      priority: 100,
      fn: () =>
        allow("test-unrelated-inject", "idle_nudge", [
          {
            type: "prompt.inject_message",
            message: "[Budget Status] keep going without triggering budget events",
          },
        ]),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.budgetReassuranceEvent).toBeUndefined();
      expect(result.budgetWarningEvent).toBeUndefined();
    }
  });

  it("returns complete when turn.start policy returns abort", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-pre-turn-abort",
      timing: "turn.start",
      priority: 100,
      fn: () => abortRun("test.abort", "pre-turn-block"),
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
    const fn = mock((_ctx: PolicyContext) =>
      appendContext("extra-context", "test.sp", "system-prompt-extend"),
    );
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

  it("context.prepare replace effect replaces an existing system prompt", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-replace-system",
      timing: "context.prepare",
      priority: 100,
      fn: () => replacePrompt("replacement prompt", "test.replace", "replace-system"),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig({ systemPrompt: "base prompt" }),
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.turn.runInput.system).toBe("replacement prompt");
    }
  });

  it("context.prepare replace effect creates a system prompt when none exists", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-replace-empty-system",
      timing: "context.prepare",
      priority: 100,
      fn: () => replacePrompt("new prompt", "test.replace", "replace-empty"),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig({ systemPrompt: undefined }),
      engine,
      { provider: "test", id: "test-model" },
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.turn.runInput.system).toBe("new prompt");
    }
  });
});

it("appends turn.start context as a user message", async () => {
  Bus.reset();
  const engine = PolicyEngine.create();
  engine.register({
    name: "test-turn-context",
    timing: "turn.start",
    priority: 100,
    fn: () => appendContext("turn context", "test.context", "append"),
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

  expect(result.type).toBe("ready");
  expect(state.messages.at(-1)?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "turn context" }),
  );
});

describe("dispatchBudgetCheck (run.finish on budget exceeded)", () => {
  it("dispatches run.finish when budget is exceeded", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
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
    expect(result?.type).toBe("complete");
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
    const fn = mock((_ctx: PolicyContext) => allow());
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
    const fn = mock((_ctx: PolicyContext) => allow("test.model-response", "observe-response"));
    const engine = PolicyEngine.create();
    engine.register({ name: "test-model-response", timing: "model.response", priority: 100, fn });

    const state = makeState();
    state.lastAssistantText = "original";
    const result = await dispatchModelResponse(
      state,
      engine,
      makeConfig(),
      "stop",
      makeAgentBase(),
    );

    expect(result).toBeNull();
    expect(state.lastAssistantText).toBe("original");
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("model.response");
    expect(ctx.toolInput?.outcomeType).toBe("stop");
  });

  it("applies model.request prompt injection before provider execution", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-model-request-inject",
      timing: "model.request",
      priority: 100,
      fn: () => inject("pre-llm context", "test.model-request", "inject"),
    });

    const state = makeState();
    const result = await dispatchModelRequest(state, engine, makeConfig());

    expect(result).toBeNull();
    expect(state.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "pre-llm context" }),
    );
  });

  it("applies model.response replacement messages with schema validation", async () => {
    Bus.reset();
    const { createUserMessage } = await import("../../../src/core/message-factory");
    const replacement = [createUserMessage("replacement", "test")];
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-model-response-replace",
      timing: "model.response",
      priority: 100,
      fn: () => replaceMessages(replacement, "test.model-response", "replace"),
    });

    const state = makeState();
    const result = await dispatchModelResponse(
      state,
      engine,
      makeConfig(),
      "stop",
      makeAgentBase(),
    );

    expect(result).toBeNull();
    expect(state.messages).toEqual(replacement);
  });

  it("blocks model.response malformed replacement messages", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-model-response-bad-replace",
      timing: "model.response",
      priority: 100,
      fn: () =>
        allow("test.model-response", "bad-replace", [
          { type: "run.replace_messages", messages: [{ invalid: true }] },
        ]),
    });

    const result = await dispatchModelResponse(
      makeState(),
      engine,
      makeConfig(),
      "stop",
      makeAgentBase(),
    );

    expect(result?.type).toBe("complete");
    if (result?.type === "complete") expect(result.result.guardAborted).toBe(true);
  });
});

describe("handleStop (turn.finish + run.finish)", () => {
  it("dispatches turn.finish on stop and completes normally", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
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

  it("emits actual tool policy decision timings", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    const state = makeState();
    state.lastAssistantText = "response text";
    const turn = makeTurnArtifacts({
      toolPolicyDecisions: [
        { timing: "invoke.prepare", decision: allow("test.pre", "pre") },
        { timing: "invoke.result", decision: allow("test.post", "post") },
      ],
    });

    const events = await collectEvents(
      handleStop(state, makeConfig(), engine, makeAgentBase(), turn),
    );

    expect(
      events
        .filter((event) => event.type === "hook_verdict")
        .map((event) => (event as Extract<AgentEvent, { type: "hook_verdict" }>).timing),
    ).toEqual(["invoke.prepare", "invoke.result", "turn.finish"]);
  });

  it("turn.finish inject verdict causes continuation", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-turn-inject",
      timing: "turn.finish",
      priority: 100,
      fn: () => inject("continue working", "test.inject", "continuation"),
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

  it("turn.finish replace_messages effect mutates state before completion", async () => {
    Bus.reset();
    const { createUserMessage } = await import("../../../src/core/message-factory");
    const replacement = [createUserMessage("turn replacement", "test")];
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-turn-replace",
      timing: "turn.finish",
      priority: 100,
      fn: () => replaceMessages(replacement, "test.turn", "replace"),
    });

    const state = makeState();
    state.lastAssistantText = "text";
    const events = await collectEvents(
      handleStop(state, makeConfig(), engine, makeAgentBase(), makeTurnArtifacts()),
    );

    expect(events.some((event) => event.type === "complete")).toBe(true);
    expect(state.messages).toEqual(replacement);
  });

  it("turn.finish abort verdict yields complete event with guardAborted", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-turn-abort",
      timing: "turn.finish",
      priority: 100,
      fn: () => abortRun("test.abort", "force-stop"),
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
    expect(completeEvent?.result.guardAborted).toBe(true);
  });

  it("turn.finish abort with reason 'stalled' sets finishReason to stalled", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-stalled",
      timing: "turn.finish",
      priority: 100,
      fn: () => abortRun("test.stalled", "stalled"),
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
    expect(completeEvent?.result.finishReason).toBe("stalled");
    expect(completeEvent?.result.guardAborted).toBeFalsy();
  });

  it("dispatches run.finish without modifying final text", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-run-transform",
      timing: "run.finish",
      priority: 100,
      fn: () => allow("test.post-run", "observe-final"),
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
    expect(completeEvent?.result.text).toBe("original");
  });
});

describe("dispatchWritebackCommit effects", () => {
  it("applies writeback.rewrite to final output", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-writeback-rewrite",
      timing: "writeback.commit",
      priority: 100,
      fn: () => rewriteWriteback("rewritten output", "test.writeback", "rewrite"),
    });

    await expect(
      dispatchWritebackCommit(makeState(), engine, makeConfig(), "original"),
    ).resolves.toBe("rewritten output");
  });

  it("applies writeback.suppress by throwing before output is returned", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-writeback-suppress",
      timing: "writeback.commit",
      priority: 100,
      fn: () =>
        allow("test.writeback", "suppress", [{ type: "writeback.suppress", reason: "redacted" }]),
    });

    await expect(
      dispatchWritebackCommit(makeState(), engine, makeConfig(), "secret"),
    ).rejects.toThrow("redacted");
  });
});

describe("handleError (error)", () => {
  it("dispatches error and respects abort verdict", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => abortRun("test.error-abort", "error-abort"));
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
    expect(completeEvent?.result.guardAborted).toBe(true);
  });

  it("error continue verdict allows retry when retry policy permits", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-on-error-continue",
      timing: "error",
      priority: 100,
      fn: () => allow(),
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

  it("applies run.retry_after delayMs before retrying", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-on-error-retry-delay",
      timing: "error",
      priority: 100,
      fn: () =>
        allow("test.retry-delay", "retry-after", [{ type: "run.retry_after", delayMs: 20 }]),
    });

    const state = makeState();
    const config = makeConfig();
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const started = Date.now();
    const gen = handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      new Error("timeout while waiting"),
      1,
      retryPolicy,
    );
    let result: IteratorResult<AgentEvent, unknown>;
    do {
      result = await gen.next();
    } while (!result.done);

    expect((result.value as { action: string }).action).toBe("retry");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("does not sleep when retry delay is already aborted", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-on-error-aborted-retry-delay",
      timing: "error",
      priority: 100,
      fn: () =>
        allow("test.aborted-retry-delay", "retry-after", [
          { type: "run.retry_after", delayMs: 5_000 },
        ]),
    });

    const controller = new AbortController();
    controller.abort();
    const state = makeState();
    const config = makeConfig({ signal: controller.signal });
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const started = Date.now();
    const gen = handleError(
      state,
      engine,
      config,
      makeAgentBase(),
      new Error("timeout while waiting"),
      1,
      retryPolicy,
    );
    await gen.next();

    await expect(gen.next()).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("applies run.retry_after maxRetries as a stricter retry ceiling", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-on-error-retry-limit",
      timing: "error",
      priority: 100,
      fn: () =>
        allow("test.retry-limit", "retry-after", [
          { type: "run.retry_after", delayMs: 0, maxRetries: 1 },
        ]),
    });

    const state = makeState();
    const config = makeConfig();
    const retryPolicy = {
      maxAttempts: 3,
      backoffMs: { initial: 0, multiplier: 1, max: 0 },
    };

    const events = await collectEvents(
      handleError(
        state,
        engine,
        config,
        makeAgentBase(),
        new Error("timeout while waiting"),
        2,
        retryPolicy,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", willRetry: false });
  });
});

describe("completion.prepare dispatch", () => {
  it("completion.prepare replace_messages effect replaces messages in state", async () => {
    Bus.reset();
    const { createUserMessage } = await import("../../../src/core/message-factory");
    const compactedMessages = [createUserMessage("compacted summary", "test")];

    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-compaction",
      timing: "completion.prepare",
      priority: 100,
      fn: () => replaceMessages(compactedMessages, "test.compact", "compact"),
    });

    const state = makeState();
    await handleCompact(state, engine, makeConfig(), makeAgentBase());

    expect(state.messages).toEqual(compactedMessages);
    expect(state.compactionCount).toBe(1);
  });

  it("completion.prepare append_context effect appends a user message", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-compaction-context",
      timing: "completion.prepare",
      priority: 100,
      fn: () => appendContext("compaction context", "test.compact", "append"),
    });

    const state = makeState();
    const result = await handleCompact(state, engine, makeConfig(), makeAgentBase());

    expect(result).toBe("continue");
    expect(state.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "compaction context" }),
    );
  });

  it("completion.prepare malformed replacement messages fail closed", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-compaction-bad-replacement",
      timing: "completion.prepare",
      priority: 100,
      fn: () =>
        allow("test.compact", "bad-replace", [
          { type: "run.replace_messages", messages: [{ invalid: true }] },
        ]),
    });

    const result = await handleCompact(makeState(), engine, makeConfig(), makeAgentBase());

    expect(result).not.toBe("continue");
    if (result !== "continue") {
      expect(result.type).toBe("complete");
      if (result.type === "complete") expect(result.result.guardAborted).toBe(true);
    }
  });

  it("completion.prepare continue verdict leaves state messages unchanged", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-compaction-noop",
      timing: "completion.prepare",
      priority: 100,
      fn,
    });

    const state = makeState();
    const originalMessages = state.messages;
    await handleCompact(state, engine, makeConfig(), makeAgentBase());

    expect(state.messages).toBe(originalMessages);
    expect(state.compactionCount).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0][0] as PolicyContext;
    expect(ctx.timing).toBe("completion.prepare");
  });
});

describe("buildPolicyEngine policy ownership", () => {
  it("registers only caller-supplied middleware", async () => {
    Bus.reset();
    const config = makeConfig({
      permissions: { action: "tool.call", denylist: ["bash"] },
      compaction: { contextWindowTokens: 1000 },
    });

    const engine = buildPolicyEngine(config, makeAgentBase());
    await expect(
      engine.dispatch("invoke.prepare", {
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        toolName: "bash",
      }),
    ).resolves.toMatchObject({ verdict: "allow" });
  });

  it("does not auto-register compaction from deprecated config", async () => {
    Bus.reset();
    const config = makeConfig({
      compaction: { contextWindowTokens: 1, thresholdRatio: 0 },
    });
    const engine = buildPolicyEngine(config, makeAgentBase());
    const state = makeState();
    const originalMessages = state.messages;

    await handleCompact(state, engine, config, makeAgentBase());

    expect(state.messages).toBe(originalMessages);
    expect(state.compactionCount).toBe(0);
  });

  it("publishes warnings for deprecated policy config fields that are ignored", async () => {
    Bus.reset();
    const warnings: Array<{ msg?: string; context?: Record<string, unknown> }> = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));

    buildPolicyEngine(
      makeConfig({
        permissions: { action: "tool.call" },
        compaction: { contextWindowTokens: 1 },
      }),
      { traceId: "trace-warning", sessionId: "sess-1" },
    );
    await Promise.resolve();
    unsubscribe();

    expect(warnings.map((warning) => warning.context?.field)).toEqual([
      "permissions",
      "compaction",
    ]);
    expect(warnings.every((warning) => warning.msg?.includes("deprecated and ignored"))).toBe(true);
  });

  it("warns for deprecated permissions even when replacement middleware is present", async () => {
    Bus.reset();
    const warnings: Array<{ context?: Record<string, unknown> }> = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));

    buildPolicyEngine(
      makeConfig({
        permissions: { action: "tool.call", denylist: ["bash"] },
        middleware: [
          {
            name: "builtin:tool-permission",
            timing: "invoke.prepare",
            priority: 0,
            fn: () => allow(),
          },
        ],
      }),
      { traceId: "trace-replacement-warning", sessionId: "sess-1" },
    );
    await Promise.resolve();
    unsubscribe();

    expect(warnings.map((warning) => warning.context)).toContainEqual(
      expect.objectContaining({
        field: "permissions",
        replacementMiddlewarePresent: true,
      }),
    );
  });

  it("honors explicit middleware supplied by the runtime builder", async () => {
    const config = makeConfig({
      middleware: [
        {
          name: "test:deny-bash",
          timing: "invoke.prepare",
          priority: 0,
          fn: () => abortRun("test.deny", "blocked"),
        },
      ],
    });

    const engine = buildPolicyEngine(config, makeAgentBase());
    await expect(
      engine.dispatch("invoke.prepare", {
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        toolName: "bash",
      }),
    ).resolves.toMatchObject({ verdict: "deny" });
  });
});
