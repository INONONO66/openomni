import { describe, expect, it } from "bun:test";
import { PolicyEngine } from "../../src/core/policy";
import { buildTurn } from "../../src/core/execution/turn";
import { measuredContextTokens } from "../../src/compaction/measure";
import {
  makeAgentBase,
  makeConfig,
  makeState,
  makeTrace,
} from "../core/execution/lifecycle-dispatch-fixture";
import { testProviderModel } from "../helpers/provider-model";
import type { Message } from "@openomni/protocol";

function assistantMessage(tokens: Message.AssistantMessage["tokens"]): Message.WithParts {
  const sessionID = "measure-session";
  return {
    info: {
      id: "measure-msg",
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens,
    },
    parts: [],
  };
}

describe("measuredContextTokens", () => {
  it("counts fresh input and both cache lanes — a cached token still occupies the window", () => {
    expect(
      measuredContextTokens({
        input: 800,
        output: 10,
        reasoning: 0,
        cache: { read: 150, write: 50 },
      }),
    ).toBe(1000);
  });
});

describe("the run measures each call", () => {
  it("records the provider-measured context off the tracking sink, where tokens land", async () => {
    const state = makeState();
    expect(state.lastCallContextTokens).toBeUndefined();

    const turn = await buildTurn(
      state,
      makeConfig(),
      PolicyEngine.create(),
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );
    if (turn.type !== "ready") throw new Error("expected a prepared turn");

    turn.turn.trackingSink.onMessage(
      assistantMessage({ input: 800, output: 10, reasoning: 0, cache: { read: 150, write: 50 } }),
    );

    expect(state.lastCallContextTokens).toBe(1000);
  });
});
