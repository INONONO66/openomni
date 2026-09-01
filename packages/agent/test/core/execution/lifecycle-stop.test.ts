import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { CanonicalPolicyRegistration } from "../../../src/core/policy/types";
import {
  registerAt,
  abortRun,
  allow,
  inject,
  replaceMessages,
} from "../../helpers/policy-decision";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { handleStop } from "../../../src/core/execution/turn";
import {
  makeAgentBase,
  makeConfig,
  makeState,
  makeTurnArtifacts,
} from "./lifecycle-dispatch-fixture";

describe("handleStop (turn.finish + run.finish)", () => {
  it("dispatches run.turn.post on stop and completes normally", async () => {
    Bus.reset();
    const fn = mock((ctx: Parameters<CanonicalPolicyRegistration["fn"]>[0]) => {
      expect(ctx.pointId).toBe("run.turn.post");
      return allow();
    });
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.turn.post", {
      name: "test-post-turn",
      priority: 100,
      fn,
    });

    const state = makeState();
    state.lastAssistantText = "response text";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const outcome = await handleStop(state, config, engine, makeAgentBase(), turn);

    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0];
    expect(ctx?.pointId).toBe("run.turn.post");
    expect(ctx?.timing).toBe("turn.finish");
    expect(ctx?.isCompletion).toBe(true);

    expect(outcome).not.toBe("continue");
  });

  it("turn.finish inject verdict causes continuation", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.turn.post",
      "test-post-turn-inject",
      100,
      () => inject("continue working", "test.inject", "continuation"),
      ["prompt.inject_message"],
    );

    const state = makeState();
    state.lastAssistantText = "partial response";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const outcome = await handleStop(state, config, engine, makeAgentBase(), turn);

    expect(outcome).toBe("continue");
    expect(state.messages.length).toBeGreaterThan(1);
    expect(state.continuationCount).toBe(1);
  });

  it("turn.finish replace_messages effect mutates state before completion", async () => {
    Bus.reset();
    const { createUserMessage } = await import("../../../src/core/message-factory");
    const replacement = [createUserMessage("turn replacement", "test")];
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.turn.post",
      "test-post-turn-replace",
      100,
      () => replaceMessages(replacement, "test.turn", "replace"),
      ["run.replace_messages"],
    );

    const state = makeState();
    state.lastAssistantText = "text";
    const outcome = await handleStop(
      state,
      makeConfig(),
      engine,
      makeAgentBase(),
      makeTurnArtifacts(),
    );

    expect(outcome).not.toBe("continue");
    expect(state.messages).toEqual(replacement);
  });

  it("turn.finish abort verdict yields complete event with guardAborted", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.turn.post",
      "test-post-turn-abort",
      100,
      () => abortRun("test.abort", "force-stop"),
      ["run.abort"],
    );

    const state = makeState();
    state.lastAssistantText = "text";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const outcome = await handleStop(state, config, engine, makeAgentBase(), turn);
    if (outcome === "continue") throw new Error("expected the run to end");
    expect(outcome.guardAborted).toBe(true);
  });

  it("turn.finish abort with reason 'stalled' sets finishReason to stalled", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.turn.post",
      "test-stalled",
      100,
      () => abortRun("test.stalled", "stalled"),
      ["run.abort"],
    );

    const state = makeState();
    state.lastAssistantText = "text";
    const config = makeConfig();
    const turn = makeTurnArtifacts();

    const outcome = await handleStop(state, config, engine, makeAgentBase(), turn);
    if (outcome === "continue") throw new Error("expected the run to end");
    expect(outcome.finishReason).toBe("stalled");
    expect(outcome.guardAborted).toBeFalsy();
  });

  it("dispatches run.finish without modifying final text", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.lifecycle.post", "test-post-run-transform", 100, () =>
      allow("test.post-run", "observe-final"),
    );

    const state = makeState();
    const config = makeConfig();
    // Audit M3 changed this fixture: the final text is the turn's OWN
    // snapshot text, not `state.lastAssistantText` (which may hold a previous
    // turn's text). This test pins that run.finish does not modify it.
    const turn = makeTurnArtifacts({
      turnAssistant: { message: createAssistantMessage("original", "", state.sessionId) },
    });

    const outcome = await handleStop(state, config, engine, makeAgentBase(), turn);
    if (outcome === "continue") throw new Error("expected the run to end");
    expect(outcome.text).toBe("original");
  });
});
