import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { AgentResult, ChatAgentConfig } from "../../../src/core/types";
import { buildTurn } from "../../../src/core/execution/turn";
import { runAgent } from "../../../src/core/execution/run";
import {
  createRunState,
  type AgentRunBase,
  type RunState,
  type RunTrace,
  type TurnArtifacts,
} from "../../../src/core/execution/state";
import { dispatchPreRun } from "../../../src/core/execution/lifecycle-dispatch";
import { handleCompact, handleStop } from "../../../src/core/execution/turn";
import { deny } from "../../helpers/policy-decision";
import { runInput } from "../../helpers/run-input";

const providerModel = { id: "test-model", providerID: "test", name: "test-model" };

function makeInput() {
  return runInput([{ role: "user", content: "hello" }]);
}

function makeConfig(overrides?: Partial<ChatAgentConfig>): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "test", id: "test-model" },
    systemPrompt: "test",
    ...overrides,
  };
}

function makeState(): RunState {
  return createRunState(makeInput());
}

function makeAgentBase(): AgentRunBase {
  return { traceId: "trace-1", sessionId: "sess-1", runId: "run-1", actorId: "actor-1" };
}

function makeTrace(): RunTrace {
  return { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" };
}

function makeTurnArtifacts(overrides?: Partial<TurnArtifacts>): TurnArtifacts {
  return {
    runInput: {
      events: Bus,
      messages: [],
      tools: [],
      model: providerModel,
      trace: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      maxSteps: 24,
    },
    trackingSink: {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    },
    turnAssistant: {},
    turnUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    toolPolicyDecisions: [],
    ...overrides,
  };
}

/** A dispatcher that ends the run returns its result; one that lets it run returns null. */
function expectComplete(result: AgentResult | null): AgentResult {
  expect(result).not.toBeNull();
  if (result === null) throw new Error("expected the dispatcher to end the run");
  return result;
}

describe("execution helper deny verdicts", () => {
  /**
   * The guard the whole `runInput` helper exists to satisfy. A run whose
   * identity was invented on its behalf emits events that correlate to
   * nothing, and the caller never learns it forgot — so the runner refuses
   * rather than mints, and this is what holds that true.
   */
  it("refuses a run that cannot name its trace, session, or run", async () => {
    for (const [missing, traceContext] of [
      ["traceId, sessionId, runId", undefined],
      ["sessionId, runId", { traceId: "trace-1" }],
      ["runId", { traceId: "trace-1", sessionId: "sess-1" }],
    ] as const) {
      const run = runAgent(
        {
          messages: [{ role: "user", content: "hello" }],
          ...(traceContext ? { traceContext } : {}),
        },
        makeConfig(),
      );
      await expect(run).rejects.toThrow(`agent run requires a trace context with ${missing}`);
    }
  });
  it("fail-closes run.start deny before execution", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "deny-run-start",
      pointIds: ["run.lifecycle.pre"],
      effectCapabilities: { "run.lifecycle.pre": ["audit.annotate"] },
      priority: 100,
      fn: () => deny("test.deny", "blocked"),
    });

    const complete = expectComplete(
      await dispatchPreRun(makeState(), engine, makeConfig(), makeAgentBase()),
    );

    expect(complete.guardAborted).toBe(true);
    expect(complete.finishReason).toBe("stop");
  });

  it("fail-closes turn.start deny before building a turn", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "deny-turn-start",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["audit.annotate"] },
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
    if (result.type !== "complete") throw new Error("expected the turn to end");
    expect(result.result.guardAborted).toBe(true);
  });

  it("fail-closes resources.prepare deny before exposing tools", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "deny-resources",
      pointIds: ["tool.catalog.pre"],
      effectCapabilities: { "tool.catalog.pre": ["audit.annotate"] },
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
    if (result.type !== "complete") throw new Error("expected the turn to end");
    expect(result.result.guardAborted).toBe(true);
  });

  it("records a diagnostic and completes normally for turn.finish deny", async () => {
    Bus.reset();
    const diagnostics: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === Operational.Info.name) diagnostics.push(payload);
    });
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "deny-turn-finish",
      pointIds: ["run.turn.post"],
      effectCapabilities: { "run.turn.post": ["audit.annotate"] },
      priority: 100,
      fn: () => deny("test.deny", "post-turn"),
    });
    const state = makeState();
    state.lastAssistantText = "done";

    let outcome: Awaited<ReturnType<typeof handleStop>>;
    try {
      outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), makeTurnArtifacts());
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    // A plain deny at turn.finish is a diagnostic, not an abort: the run ends
    // normally and `guardAborted` stays unset.
    expect(outcome).not.toBe("continue");
    if (outcome === "continue") throw new Error("expected the run to end");
    expect(outcome.guardAborted).toBeUndefined();
    expect(hasDenyDiagnostic(diagnostics, "turn.finish")).toBe(true);
  });

  it("records a diagnostic and fail-closes completion.prepare deny", async () => {
    Bus.reset();
    const diagnostics: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === Operational.Info.name) diagnostics.push(payload);
    });
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "deny-compaction",
      pointIds: ["run.completion.pre"],
      effectCapabilities: { "run.completion.pre": ["audit.annotate"] },
      priority: 100,
      fn: () => deny("test.deny", "post-compaction"),
    });

    try {
      const result = await handleCompact(makeState(), engine, makeConfig(), makeAgentBase());
      await Promise.resolve();

      expect(result).not.toBe("continue");
      if (result === "continue") throw new Error("expected the run to end");
      expect(result.guardAborted).toBe(true);
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
