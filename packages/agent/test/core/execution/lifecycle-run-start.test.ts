import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { AgentEvent } from "../../../src/core/types";
import { abortRun, allow, appendContext, inject } from "../../helpers/policy-decision";
import { dispatchPreRun } from "../../../src/core/execution/lifecycle-dispatch";
import { makeConfig, makeState } from "./lifecycle-dispatch-fixture";

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
