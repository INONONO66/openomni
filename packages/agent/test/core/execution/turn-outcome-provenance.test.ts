import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "../../../src/core/types";
import { PolicyEngine } from "../../../src/core/policy";
import { handleStop } from "../../../src/core/execution/turn-outcome";
import {
  createRunState,
  type AgentRunBase,
  type TurnArtifacts,
} from "../../../src/core/execution/run-state";
import { allow } from "../../helpers/policy-decision";

function makeAgentBase(): AgentRunBase {
  return { traceId: "trace-1", sessionId: "sess-1" };
}

function makeTurnArtifacts(): TurnArtifacts {
  return {
    runInput: {
      messages: [],
      tools: [],
      model: { provider: "test", id: "test-model" },
      maxSteps: 24,
    },
    trackingSink: {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onSnapshot: () => undefined,
    },
    turnUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnToolCalls: [],
    turnToolResults: [],
    toolPolicyDecisions: [],
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentEvent, "complete" | "continue">,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("handleStop prompt injection provenance", () => {
  it("preserves assistant role through turn.finish continuation", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "test-post-turn-assistant-inject",
      timing: "turn.finish",
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
    const state = createRunState({
      messages: [{ role: "user", content: "parent request" }],
    });
    state.lastAssistantText = "partial response";

    const events = await collectEvents(
      handleStop(
        state,
        { model: { provider: "test", id: "test-model" } },
        engine,
        makeAgentBase(),
        makeTurnArtifacts(),
      ),
    );

    expect(events.some((event) => event.type === "turn_complete")).toBe(true);
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
