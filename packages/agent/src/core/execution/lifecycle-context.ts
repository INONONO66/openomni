import type { DispatchContext } from "../policy";
import type { ChatAgentConfig } from "../types";
import type { AgentRunBase, RunState } from "./run-state";

type LifecyclePolicyContextOverrides = Partial<
  Pick<
    DispatchContext,
    "turnCount" | "continuationCount" | "elapsedMs" | "isCompletion" | "toolInput"
  >
> &
  Record<string, unknown>;

export function buildLifecyclePolicyContext(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  overrides: LifecyclePolicyContextOverrides = {},
): DispatchContext & Record<string, unknown> {
  const { elapsedMs = Date.now() - state.startTime, ...rest } = overrides;
  return {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
    sessionId: agentBase.sessionId || state.sessionId,
    runId: agentBase.runId ?? agentBase.traceId,
    ...rest,
  };
}

export function agentBaseForState(state: RunState): AgentRunBase {
  return {
    traceId: state.sessionId,
    sessionId: state.sessionId,
    runId: state.sessionId,
    actorId: state.sessionId,
  };
}
