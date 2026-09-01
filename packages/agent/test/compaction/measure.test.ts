import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { PolicyEngine } from "../../src/core/policy";
import { buildTurn } from "../../src/core/execution/turn";
import { applyCompactionMessages, replaceRunMessages } from "../../src/core/execution/state";
import { measuredContextTokens } from "../../src/compaction/measure";
import {
  makeAgentBase,
  makeConfig,
  makeState,
  makeTrace,
} from "../core/execution/lifecycle-dispatch-fixture";
import { testProviderModel } from "../helpers/provider-model";

const sessionID = "measure-session";

function stepFinishPart(input: number, read: number, write: number): Message.StepFinishPart {
  return {
    id: `step-${input}`,
    sessionID,
    messageID: "measure-msg",
    type: "step-finish",
    reason: "end_turn",
    cost: 0,
    tokens: { input, output: 10, reasoning: 0, cache: { read, write } },
  };
}

function assistantMessage(parts: Message.Part[], turnTotals: { input: number }): Message.WithParts {
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
      tokens: {
        input: turnTotals.input,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts,
  };
}

describe("measuredContextTokens", () => {
  it("reads the LAST step's input — the turn total sums every step's resent conversation", () => {
    // Pipeline-shaped: each step's `input` is the ai SDK's cache-inclusive
    // prompt total (the token-tracker pin fixes input 100 = 90+7+3), and the
    // message-level tokens field carries the SUM of the steps (3000), which
    // is not a window size.
    const message = assistantMessage(
      [stepFinishPart(900, 800, 0), stepFinishPart(1000, 900, 20), stepFinishPart(1100, 1000, 0)],
      { input: 3000 },
    );
    expect(measuredContextTokens(message)).toBe(1100);
  });

  it("does not add the cache lanes back — input already includes them", () => {
    const message = assistantMessage([stepFinishPart(1000, 900, 50)], { input: 1000 });
    expect(measuredContextTokens(message)).toBe(1000);
  });

  it("measures nothing when no step finished", () => {
    expect(measuredContextTokens(assistantMessage([], { input: 0 }))).toBeUndefined();
  });
});

describe("the run measures the final call", () => {
  async function preparedTurn(state: ReturnType<typeof makeState>) {
    const turn = await buildTurn(
      state,
      makeConfig(),
      PolicyEngine.create({ clock: Date.now }),
      testProviderModel,
      undefined,
      makeTrace(),
      makeAgentBase(),
    );
    if (turn.type !== "ready") throw new Error("expected a prepared turn");
    return turn.turn;
  }

  it("records the last step's window off the tracking sink, where tokens land", async () => {
    const state = makeState();
    expect(state.lastCallContextTokens).toBeUndefined();
    const turn = await preparedTurn(state);

    turn.trackingSink.onMessage(
      assistantMessage([stepFinishPart(900, 800, 0), stepFinishPart(1100, 1000, 0)], {
        input: 2000,
      }),
    );

    expect(state.lastCallContextTokens).toBe(1100);
  });

  it("clears the measurement when history is rewritten under it", async () => {
    const state = makeState();
    const turn = await preparedTurn(state);
    turn.trackingSink.onMessage(assistantMessage([stepFinishPart(1100, 1000, 0)], { input: 1100 }));
    expect(state.lastCallContextTokens).toBe(1100);

    replaceRunMessages(state, []);

    expect(state.lastCallContextTokens).toBeUndefined();
  });

  it("clears the measurement on the compaction path itself, not just the effect path", async () => {
    // The re-review proved the first clearing pin tested a function the
    // compaction application bypassed. This one drives applyCompactionMessages,
    // which is what applyPostCompaction actually calls.
    const state = makeState();
    const turn = await preparedTurn(state);
    turn.trackingSink.onMessage(assistantMessage([stepFinishPart(1100, 1000, 0)], { input: 1100 }));
    expect(state.lastCallContextTokens).toBe(1100);

    applyCompactionMessages(state, []);

    expect(state.lastCallContextTokens).toBeUndefined();
    expect(state.compactionCount).toBe(1);
  });
});
