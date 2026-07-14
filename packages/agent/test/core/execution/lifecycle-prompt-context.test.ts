import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/session";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import { appendContext, replacePrompt } from "../../helpers/policy-decision";
import { buildTurn } from "../../../src/core/execution/turn-prepare";
import { makeAgentBase, makeConfig, makeState, makeTrace } from "./lifecycle-dispatch-fixture";

describe("buildTurn (prompt.context.pre)", () => {
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
