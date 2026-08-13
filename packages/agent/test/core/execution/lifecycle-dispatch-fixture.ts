import type { TraceContext } from "@openomni/protocol";
import type { AgentEvent, ChatAgentConfig, ChatAgentInput } from "../../../src/core/types";
import {
  createRunState,
  type AgentRunBase,
  type RunState,
  type TurnArtifacts,
} from "../../../src/core/execution/run-state";

function makeInput(): ChatAgentInput {
  return { messages: [{ role: "user", content: "hello" }] };
}

export function makeConfig(overrides?: Partial<ChatAgentConfig>): ChatAgentConfig {
  return {
    model: { provider: "test", id: "test-model" },
    systemPrompt: "test",
    ...overrides,
  };
}

export function makeAgentBase(): AgentRunBase {
  return { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" };
}

export function makeTrace(): TraceContext.Type {
  return { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" };
}

export function makeState(): RunState {
  return createRunState(makeInput());
}

export function makeTurnArtifacts(overrides?: Partial<TurnArtifacts>): TurnArtifacts {
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
    },
    turnAssistant: {},
    turnUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    turnToolCalls: [],
    turnToolResults: [],
    toolPolicyDecisions: [],
    ...overrides,
  };
}

export async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}
