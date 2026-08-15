import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import { createCompactionPolicy } from "../../../src/compaction";
import { createUserMessage } from "../../../src/core/message-factory";
import { handleCompact } from "../../../src/core/execution/turn";
import { buildLifecyclePolicyContext } from "../../../src/core/execution/state";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

/**
 * The builtin compaction policy reports what it did, so it needs the run's
 * trace — and it can only get one from the context the lifecycle builds.
 *
 * Pinning that through a hand-built `ctx` proves nothing: the fixture can be
 * given a `traceContext` the production path never sets. #613's first review
 * caught exactly that, after the guard turned a fail-closed point into a
 * silent run abort. These drive the real path.
 */
describe("compaction through the lifecycle", () => {
  it("the lifecycle context carries the run's trace", () => {
    const agentBase = makeAgentBase();
    const state = makeState();
    // `makeState` mints its own session id, so these differ — which is what
    // makes the assertions below discriminate. The context used to read
    // `agentBase.sessionId || state.sessionId` and `agentBase.runId ||
    // agentBase.traceId`; either fallback firing would show up here.
    expect(state.sessionId).not.toBe(agentBase.sessionId);
    const ctx = buildLifecyclePolicyContext(state, makeConfig(), agentBase, {
      isCompletion: true,
    });

    // `packages/policy`'s audit resolves `ctx.traceContext ?? options.traceContext`,
    // so this now outranks the engine's — a field missing here is a field
    // missing from every lifecycle audit record.
    expect((ctx as { traceContext?: Record<string, string | undefined> }).traceContext).toEqual({
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId,
      runId: agentBase.runId,
    });
    expect(ctx.sessionId).toBe(agentBase.sessionId);
    expect(ctx.runId).toBe(agentBase.runId);
  });

  it("files the compaction record under the run's trace, not a minted one", async () => {
    const seen: Array<{ traceId: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Info, (event) => {
      seen.push(event as unknown as { traceId: string });
    });
    const engine = PolicyEngine.create();
    engine.register(
      createCompactionPolicy({
        contextWindowTokens: 100,
        protectRecentMessages: 2,
        events: Bus,
        priority: 900,
      }),
    );
    const agentBase = makeAgentBase();

    const state = makeState();
    state.messages = Array.from({ length: 12 }, (_unused, index) =>
      createUserMessage(`message ${index}`, state.sessionId),
    );
    state.lastCallContextTokens = 900;

    try {
      await handleCompact(state, engine, makeConfig(), agentBase);
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    const records = seen.filter((event) => event.traceId === agentBase.traceId);
    expect(records.length).toBeGreaterThan(0);
  });

  it("compacts rather than aborting when the threshold is exceeded", async () => {
    const engine = PolicyEngine.create();
    engine.register(
      createCompactionPolicy({
        contextWindowTokens: 100,
        protectRecentMessages: 2,
        events: Bus,
        priority: 900,
      }),
    );

    const state = makeState();
    state.messages = Array.from({ length: 12 }, (_unused, index) =>
      createUserMessage(`message ${index}`, state.sessionId),
    );
    state.lastCallContextTokens = 900;

    const decision = await handleCompact(state, engine, makeConfig(), makeAgentBase());

    expect(decision).toBe("continue");
    expect(state.compactionCount).toBe(1);
  });
});
