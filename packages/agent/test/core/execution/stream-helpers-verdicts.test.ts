import { describe, expect, it, mock } from "bun:test";
import { Operational, type TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { AgentEvent, ChatAgentConfig, ChatAgentInput } from "../../../src/core/types";
import {
  buildTurn,
  createStreamRunState,
  dispatchModelRequest,
  dispatchModelResponse,
  dispatchPreRun,
  dispatchWritebackCommit,
  handleCompact,
  handleStop,
  type StreamAgentBase,
  type StreamRunState,
  type TurnArtifacts,
} from "../../../src/core/execution/stream-helpers";

const providerModel = { id: "test-model", providerID: "test", name: "test-model" };

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

function makeState(): StreamRunState {
  return createStreamRunState(makeInput());
}

function makeAgentBase(): StreamAgentBase {
  return { traceId: "trace-1", sessionId: "sess-1" };
}

function makeTrace(): TraceContext.Type {
  return { traceId: "trace-1", sessionId: "sess-1" };
}

function makeTurnArtifacts(overrides?: Partial<TurnArtifacts>): TurnArtifacts {
  return {
    runInput: {
      messages: [],
      tools: [],
      model: providerModel,
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
  for await (const event of gen) events.push(event);
  return events;
}

function expectComplete(event: AgentEvent | null): Extract<AgentEvent, { type: "complete" }> {
  expect(event).not.toBeNull();
  expect(event!.type).toBe("complete");
  return event as Extract<AgentEvent, { type: "complete" }>;
}

describe("stream helper deny verdicts", () => {
  it("fail-closes run.start deny before execution", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-run-start",
      timing: "run.start",
      priority: 100,
      fn: () => ({ action: "deny", reason: "blocked", policyId: "test.deny" }),
    });

    const complete = expectComplete(await dispatchPreRun(makeState(), engine, makeConfig()));

    expect(complete.result.guardAborted).toBe(true);
    expect(complete.result.finishReason).toBe("stop");
  });

  it("fail-closes turn.start deny before building a turn", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-turn-start",
      timing: "turn.start",
      priority: 100,
      fn: () => ({ action: "deny", reason: "blocked", policyId: "test.deny" }),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      providerModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("complete");
    if (result.type === "complete" && result.event.type === "complete") {
      expect(result.event.result.guardAborted).toBe(true);
    }
  });

  it("fail-closes resources.prepare deny before exposing tools", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-resources",
      timing: "resources.prepare",
      priority: 100,
      fn: () => ({ action: "deny", reason: "no-tools", policyId: "test.deny" }),
    });

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      providerModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("complete");
    if (result.type === "complete" && result.event.type === "complete") {
      expect(result.event.result.guardAborted).toBe(true);
    }
  });

  it("fail-closes model.request deny before provider execution", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => ({
      action: "deny" as const,
      reason: "provider-blocked",
      policyId: "test.deny",
    }));
    const engine = PolicyEngine.create();
    engine.register({ name: "deny-model-request", timing: "model.request", priority: 100, fn });

    const complete = expectComplete(await dispatchModelRequest(makeState(), engine, makeConfig()));

    expect(complete.result.guardAborted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("records a diagnostic and keeps model.response deny fail-open", async () => {
    Bus.reset();
    const diagnostics: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === Operational.Info.name) diagnostics.push(payload);
    });
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-model-response",
      timing: "model.response",
      priority: 100,
      fn: () => ({ action: "deny", reason: "after-provider", policyId: "test.deny" }),
    });

    try {
      const result = await dispatchModelResponse(makeState(), engine, makeConfig(), "stop");
      await Promise.resolve();

      expect(result).toBeNull();
      expect(hasDenyDiagnostic(diagnostics, "model.response")).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("emits a hook verdict and completes normally for turn.finish deny", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-turn-finish",
      timing: "turn.finish",
      priority: 100,
      fn: () => ({ action: "deny", reason: "post-turn", policyId: "test.deny" }),
    });
    const state = makeState();
    state.lastAssistantText = "done";

    const events = await collectEvents(
      handleStop(state, makeConfig(), engine, makeAgentBase(), makeTurnArtifacts()),
    );
    const hook = events.find((event) => event.type === "hook_verdict");
    const complete = events.find((event) => event.type === "complete") as
      | Extract<AgentEvent, { type: "complete" }>
      | undefined;

    expect(hook).toMatchObject({ timing: "turn.finish", action: "deny", reason: "post-turn" });
    expect(complete).toBeDefined();
    expect(complete!.result.guardAborted).toBeUndefined();
  });

  it("records a diagnostic and keeps completion.prepare deny fail-open", async () => {
    Bus.reset();
    const diagnostics: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === Operational.Info.name) diagnostics.push(payload);
    });
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-compaction",
      timing: "completion.prepare",
      priority: 100,
      fn: () => ({ action: "deny", reason: "post-compaction", policyId: "test.deny" }),
    });

    try {
      const result = await handleCompact(makeState(), engine, makeConfig(), makeAgentBase());
      await Promise.resolve();

      expect(result).toBe("continue");
      expect(hasDenyDiagnostic(diagnostics, "completion.prepare")).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("fail-closes writeback.commit deny before returning output", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-writeback",
      timing: "writeback.commit",
      priority: 100,
      fn: () => ({ action: "deny", reason: "no-writeback", policyId: "test.deny" }),
    });

    try {
      await dispatchWritebackCommit(makeState(), engine, makeConfig(), "output");
      throw new Error("expected writeback deny to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("no-writeback");
    }
  });
});

function hasDenyDiagnostic(diagnostics: unknown[], timing: string): boolean {
  return diagnostics.some((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object") return false;
    const payload = diagnostic as { component?: unknown; msg?: unknown; context?: unknown };
    if (payload.component !== "agent" || payload.msg !== "agent.policy.deny.diagnostic") {
      return false;
    }
    if (!payload.context || typeof payload.context !== "object") return false;
    return (payload.context as { timing?: unknown }).timing === timing;
  });
}
