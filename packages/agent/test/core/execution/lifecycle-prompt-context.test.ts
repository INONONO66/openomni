import { describe, expect, it, mock } from "bun:test";
import { testProviderModel } from "../../helpers/provider-model";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { CanonicalPolicyRegistration } from "../../../src/core/policy/types";
import { registerAt, appendContext, replacePrompt } from "../../helpers/policy-decision";
import { buildTurn } from "../../../src/core/execution/turn";
import { makeAgentBase, makeConfig, makeState, makeTrace } from "./lifecycle-dispatch-fixture";

describe("buildTurn (prompt.context.pre)", () => {
  it("dispatches prompt.context.pre during buildTurn", async () => {
    Bus.reset();
    const fn = mock((ctx: Parameters<CanonicalPolicyRegistration["fn"]>[0]) => {
      expect(ctx.pointId).toBe("prompt.context.pre");
      return appendContext("extra-context", "test.sp", "system-prompt-extend");
    });
    const engine = PolicyEngine.create();
    registerAt(engine, "prompt.context.pre", {
      name: "test-sp",
      effects: ["prompt.append_context"],
      priority: 100,
      fn,
    });

    const state = makeState();
    const config = makeConfig({ systemPrompt: "base prompt" });
    const result = await buildTurn(
      state,
      config,
      engine,
      testProviderModel,
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

  it("prompt.context.pre replace effect replaces an existing system prompt", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "prompt.context.pre",
      "test-replace-system",
      100,
      () => replacePrompt("replacement prompt", "test.replace", "replace-system"),
      ["prompt.replace"],
    );

    const result = await buildTurn(
      makeState(),
      makeConfig({ systemPrompt: "base prompt" }),
      engine,
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );

    expect(result.type).toBe("ready");
    if (result.type === "ready") {
      expect(result.turn.runInput.system).toBe("replacement prompt");
    }
  });

  it("prompt.context.pre replace effect creates a system prompt when none exists", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "prompt.context.pre",
      "test-replace-empty-system",
      100,
      () => replacePrompt("new prompt", "test.replace", "replace-empty"),
      ["prompt.replace"],
    );

    const result = await buildTurn(
      makeState(),
      makeConfig({ systemPrompt: undefined }),
      engine,
      testProviderModel,
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
