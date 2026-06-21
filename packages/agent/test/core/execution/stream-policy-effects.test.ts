import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { StreamPolicyEffects } from "../../../src/core/execution/stream-policy-effects";
import { createStreamRunState } from "../../../src/core/execution/stream-state";

describe("StreamPolicyEffects", () => {
  it("preserves assistant provenance for injected prompt messages", () => {
    const state = createStreamRunState({
      messages: [{ role: "user", content: "parent request" }],
    });
    const parentID = state.messages.at(-1)?.info.id;
    const decision = PolicyDecision.allow({
      policyId: "test",
      effects: [
        {
          type: "prompt.inject_message",
          message: "child result",
          role: "assistant",
        },
      ],
    });

    StreamPolicyEffects.applyPromptMessageEffects(state, decision);

    expect(state.messages.at(-1)?.info).toMatchObject({
      role: "assistant",
      parentID,
    });
    expect(state.messages.at(-1)?.parts[0]).toMatchObject({
      type: "text",
      text: "child result",
    });
  });
});
