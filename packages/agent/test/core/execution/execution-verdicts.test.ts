import { describe, expect, it } from "bun:test";
import { Operational, type TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { AgentEvent, ChatAgentConfig, ChatAgentInput } from "../../../src/core/types";
import { buildTurn } from "../../../src/core/execution/turn-prepare";
import {
  createRunState,
  type AgentRunBase,
  type RunState,
  type TurnArtifacts,
} from "../../../src/core/execution/run-state";
import { dispatchPreRun } from "../../../src/core/execution/lifecycle-dispatch";
import { handleCompact, handleStop } from "../../../src/core/execution/turn-outcome";
import { deny } from "../../helpers/policy-decision";

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

function makeState(): RunState {
  return createRunState(makeInput());
}

function makeAgentBase(): AgentRunBase {
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
    turnAssistant: {},
    turnUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    turnToolCalls: [],
    turnToolResults: [],
    toolPolicyDecisions: [],
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
  expect(event?.type).toBe("complete");
  return event as Extract<AgentEvent, { type: "complete" }>;
}

describe("execution helper deny verdicts", () => {
  it("fail-closes run.start deny before execution", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-run-start",
      timing: "run.start",
      priority: 100,
      fn: () => deny("test.deny", "blocked"),
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
      fn: () => deny("test.deny", "blocked"),
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
      fn: () => deny("test.deny", "no-tools"),
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

  it("emits a hook verdict and completes normally for turn.finish deny", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      name: "deny-turn-finish",
      timing: "turn.finish",
      priority: 100,
      fn: () => deny("test.deny", "post-turn"),
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
    expect(complete?.result.guardAborted).toBeUndefined();
  });

  it("records a diagnostic and fail-closes completion.prepare deny", async () => {
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
      fn: () => deny("test.deny", "post-compaction"),
    });

    try {
      const result = await handleCompact(makeState(), engine, makeConfig(), makeAgentBase());
      await Promise.resolve();

      expect(result).not.toBe("continue");
      if (result !== "continue") {
        expect(result.type).toBe("complete");
        if (result.type === "complete") expect(result.result.guardAborted).toBe(true);
      }
      expect(hasDenyDiagnostic(diagnostics, "completion.prepare")).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});

function hasDenyDiagnostic(diagnostics: unknown[], timing: string): boolean {
  return Boolean(findDenyDiagnostic(diagnostics, timing));
}

function findDenyDiagnostic(
  diagnostics: unknown[],
  timing: string,
): { traceId?: unknown; sessionId?: unknown } | undefined {
  return diagnostics.find((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object") return false;
    const payload = diagnostic as { component?: unknown; msg?: unknown; context?: unknown };
    if (payload.component !== "agent" || payload.msg !== "agent.policy.deny.diagnostic") {
      return false;
    }
    if (!payload.context || typeof payload.context !== "object") return false;
    return (payload.context as { timing?: unknown }).timing === timing;
  }) as { traceId?: unknown; sessionId?: unknown } | undefined;
}
