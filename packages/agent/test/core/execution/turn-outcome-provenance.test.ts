import { describe, expect, it } from "bun:test";
import { PolicyEngine } from "../../../src/core/policy";
import { handleStop } from "../../../src/core/execution/turn-outcome";
import {
  createRunState,
  type AgentRunBase,
  type TurnArtifacts,
} from "../../../src/core/execution/run-state";
import { allow } from "../../helpers/policy-decision";
import { runInput } from "../../helpers/run-input";
import { testProviderModel } from "../../helpers/provider-model";
import { Bus } from "@openomni/telemetry";

// The run and the input it produces share one identity. Derived this way
// round, not the other: `AgentRunBase.runId` is optional and `RunInput.trace`'s
// is not, so reading it back off the base would widen it.
const runTrace = { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" };

function makeAgentBase(): AgentRunBase {
  return { ...runTrace, actorId: "actor-1" };
}

function makeTurnArtifacts(): TurnArtifacts {
  return {
    runInput: {
      messages: [],
      tools: [],
      events: Bus,
      model: testProviderModel,
      maxSteps: 24,
      trace: runTrace,
    },
    trackingSink: {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    },
    turnAssistant: {},
    turnUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnToolCalls: [],
    turnToolResults: [],
    toolPolicyDecisions: [],
  };
}

describe("handleStop prompt injection provenance", () => {
  it("preserves assistant role through turn.finish continuation", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-post-turn-assistant-inject",
      pointIds: ["run.turn.post"],
      effectCapabilities: { "run.turn.post": ["prompt.inject_message"] },
      priority: 100,
      fn: () =>
        allow("test.inject", "continuation", [
          {
            type: "prompt.inject_message",
            message: "child result",
            role: "assistant",
          },
        ]),
    });
    const state = createRunState(runInput([{ role: "user", content: "parent request" }]));
    state.lastAssistantText = "partial response";

    const outcome = await handleStop(
      state,
      { events: Bus, model: { provider: "test", id: "test-model" } },
      engine,
      makeAgentBase(),
      makeTurnArtifacts(),
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
