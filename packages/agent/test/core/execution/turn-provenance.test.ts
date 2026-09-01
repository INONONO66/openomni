import { describe, expect, it } from "bun:test";
import { PolicyEngine } from "../../../src/core/policy";
import { handleStop } from "../../../src/core/execution/turn";
import { createRunState } from "../../../src/core/execution/state";
import { registerAt, allow } from "../../helpers/policy-decision";
import { runInput } from "../../helpers/run-input";
import { Bus } from "@openomni/telemetry";
import { makeAgentBase, makeTurnArtifacts } from "./lifecycle-dispatch-fixture";

describe("handleStop prompt injection provenance", () => {
  it("preserves assistant role through turn.finish continuation", async () => {
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "run.turn.post",
      "test-post-turn-assistant-inject",
      100,
      () =>
        allow("test.inject", "continuation", [
          {
            type: "prompt.inject_message",
            message: "child result",
            role: "assistant",
          },
        ]),
      ["prompt.inject_message"],
    );
    const state = createRunState(runInput([{ role: "user", content: "parent request" }]));
    state.lastAssistantText = "partial response";

    const outcome = await handleStop(
      state,
      { events: Bus, model: { provider: "test", id: "test-model" } },
      engine,
      makeAgentBase(),
      makeTurnArtifacts({ turnUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
    );

    expect(outcome).toBe("continue");
    expect(state.continuationCount).toBe(1);
    expect(state.messages.at(-1)?.info).toMatchObject({
      role: "assistant",
      parentID: state.messages.at(-2)?.info.id,
    });
    expect(state.messages.at(-1)?.parts[0]).toMatchObject({
      type: "text",
      text: "child result",
    });
  });
});
