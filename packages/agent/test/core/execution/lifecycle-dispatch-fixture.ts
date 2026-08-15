import type { ChatAgentConfig } from "../../../src/core/types";
import {
  createRunState,
  type AgentRunBase,
  type RunTrace,
  type RunState,
  type TurnArtifacts,
} from "../../../src/core/execution/state";
import { runInput } from "../../helpers/run-input";
import { testProviderModel } from "../../helpers/provider-model";
import { Bus } from "@openomni/telemetry";

function makeInput() {
  return runInput([{ role: "user", content: "hello" }]);
}

export function makeConfig(overrides?: Partial<ChatAgentConfig>): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "test", id: "test-model" },
    systemPrompt: "test",
    ...overrides,
  };
}

export function makeAgentBase(): AgentRunBase {
  return { traceId: "trace-1", sessionId: "sess-1", runId: "run-1", actorId: "actor-1" };
}

export function makeTrace(): RunTrace {
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
      events: Bus,
      model: testProviderModel,
      maxSteps: 24,
      trace: makeTrace(),
    },
    trackingSink: {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    },
    turnAssistant: {},
    turnUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    toolPolicyDecisions: [],
    stepCap: 24,
    windowYieldArmed: false,
    ...overrides,
  };
}
