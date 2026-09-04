import { describe, expect, it, mock } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Bus } from "../../../src/index";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import {
  atPoint,
  registerAt,
  abortRun,
  allow,
  appendContext,
  inject,
} from "../../helpers/policy-decision";
import { dispatchPreRun } from "../../../src/core/execution/lifecycle-dispatch";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

describe("dispatchPreRun (run.start)", () => {
  it("dispatches run.start and allows continuation on continue verdict", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.lifecycle.pre", {
      name: "test-pre-run",
      priority: 100,
      fn,
    });

    const state = makeState();
    const result = await dispatchPreRun(state, engine, makeConfig(), makeAgentBase());

    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0] as PolicyContext;
    expect(ctx.timing).toBe("run.start");
  });

  it("returns abort event when run.start policy returns abort", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.lifecycle.pre",
      "test-pre-run-abort",
      100,
      () => abortRun("test.abort", "pre-run-block"),
      ["run.abort"],
    );

    const state = makeState();
    const result = await dispatchPreRun(state, engine, makeConfig(), makeAgentBase());

    expect(result).not.toBeNull();
    expect(result?.guardAborted).toBe(true);
    expect(result?.finishReason).toBe("stop");
  });

  it("injects user message when run.start policy returns inject", async () => {
    Bus.reset();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.lifecycle.pre",
      "test-pre-run-inject",
      100,
      () => inject("injected-context", "test.inject", "add-context"),
      ["prompt.inject_message"],
    );

    const state = makeState();
    const messagesBefore = state.messages.length;
    const result = await dispatchPreRun(state, engine, makeConfig(), makeAgentBase());

    expect(result).toBeNull();
    expect(state.messages.length).toBe(messagesBefore + 1);
    const lastMsg = state.messages.at(-1);
    if (!lastMsg) throw new Error("expected injected message");
    expect(lastMsg.info.role).toBe("user");
    const text = lastMsg.parts
      .filter((p): p is Message.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("injected-context");
  });
});

it("appends run.start context as a user message", async () => {
  Bus.reset();
  const engine = PolicyEngine.create({ clock: Date.now });
  engine.register(
    atPoint("run.lifecycle.pre", {
      name: "test-pre-run-context",
      effects: ["prompt.append_context"],
      priority: 100,
      fn: () => appendContext("run context", "test.context", "append"),
    }),
  );

  const state = makeState();
  const result = await dispatchPreRun(state, engine, makeConfig(), makeAgentBase());

  expect(result).toBeNull();
  expect(state.messages.at(-1)?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "run context" }),
  );
});
