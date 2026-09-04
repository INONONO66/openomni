import { buildTurn, handleStop } from "../../../src/core/execution/turn";
import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "../../../src/index";
import { PolicyEngine } from "../../../src/core/policy";
import type { AgentResult } from "../../../src/core/types";
import { runAgent } from "../../../src/core/execution/run";
import { dispatchPreRun } from "../../../src/core/execution/lifecycle-dispatch";
import { registerAt, deny } from "../../helpers/policy-decision";
import { testProviderModel } from "../../helpers/provider-model";
import {
  makeAgentBase,
  makeConfig,
  makeState,
  makeTrace,
  makeTurnArtifacts,
} from "./lifecycle-dispatch-fixture";

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
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.lifecycle.pre",
      "deny-run-start",
      100,
      () => deny("test.deny", "blocked"),
      ["audit.annotate"],
    );

    const complete = expectComplete(
      await dispatchPreRun(makeState(), engine, makeConfig(), makeAgentBase()),
    );

    expect(complete.guardAborted).toBe(true);
    expect(complete.finishReason).toBe("stop");
  });

  it("fail-closes turn.start deny before building a turn", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.turn.pre", "deny-turn-start", 100, () => deny("test.deny", "blocked"), [
      "audit.annotate",
    ]);

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      testProviderModel,
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
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "tool.catalog.pre",
      "deny-resources",
      100,
      () => deny("test.deny", "no-tools"),
      ["audit.annotate"],
    );

    const result = await buildTurn(
      makeState(),
      makeConfig(),
      engine,
      testProviderModel,
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
      if (event.name === Operational.Events.Info.name) diagnostics.push(payload);
    });
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.turn.post",
      "deny-turn-finish",
      100,
      () => deny("test.deny", "post-turn"),
      ["audit.annotate"],
    );
    const state = makeState();
    state.lastAssistantText = "done";

    let outcome: Awaited<ReturnType<typeof handleStop>>;
    try {
      outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), makeTurnArtifacts());
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
