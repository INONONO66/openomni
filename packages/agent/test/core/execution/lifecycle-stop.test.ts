import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { AgentEvent } from "../../../src/core/types";
import { abortRun, allow, inject, replaceMessages } from "../../helpers/policy-decision";
import { handleStop } from "../../../src/core/execution/turn-outcome";
import {
  collectEvents,
  makeAgentBase,
  makeConfig,
  makeState,
  makeTurnArtifacts,
} from "./lifecycle-dispatch-fixture";

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
