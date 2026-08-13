import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEffectApplier } from "../../../src/core/execution/policy-effects";
import { createRunState } from "../../../src/core/execution/run-state";
import { runInput } from "../../helpers/run-input";

describe("PolicyEffectApplier", () => {
  it("preserves assistant provenance for injected prompt messages", () => {
    const state = createRunState(runInput([{ role: "user", content: "parent request" }]));
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

    PolicyEffectApplier.applyPromptMessageEffects(state, decision);

    expect(state.messages.at(-1)?.info).toMatchObject({
      role: "assistant",
      parentID,
    });
    expect(state.messages.at(-1)?.parts[0]).toMatchObject({
      type: "text",
      text: "child result",
    });
  });

  it("chains parent ids across injected prompt messages in the same batch", () => {
    const state = createRunState(runInput([{ role: "user", content: "parent request" }]));
    const decision = PolicyDecision.allow({
      policyId: "test",
      effects: [
        {
          type: "prompt.inject_message",
          message: "first child result",
          role: "assistant",
        },
        {
          type: "prompt.inject_message",
          message: "second child result",
          role: "assistant",
        },
      ],
    });

    PolicyEffectApplier.applyPromptMessageEffects(state, decision);

    const firstInjected = state.messages.at(-2);
    const secondInjected = state.messages.at(-1);
    expect(firstInjected?.info.role).toBe("assistant");
    expect(secondInjected?.info).toMatchObject({
      role: "assistant",
      parentID: firstInjected?.info.id,
    });
  });
});
