import type { DispatchContext } from "../policy";
import type { ChatAgentConfig } from "../types";
import type { StreamRunState } from "./stream-state";

type LifecyclePolicyContextOverrides = Partial<
  Pick<
    DispatchContext,
    "turnCount" | "continuationCount" | "elapsedMs" | "isCompletion" | "toolInput"
  >
>;

export function buildLifecyclePolicyContext(
  state: StreamRunState,
  config: ChatAgentConfig,
  overrides: LifecyclePolicyContextOverrides = {},
): DispatchContext {
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
    ...rest,
  };
}
