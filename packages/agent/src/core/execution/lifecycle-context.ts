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

export function buildLifecyclePolicyContext<
  const TOverrides extends LifecyclePolicyContextOverrides = Record<string, never>,
>(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  overrides: TOverrides = {} as TOverrides,
): Omit<DispatchContext, "actorId" | "sessionId" | "runId"> &
  Omit<TOverrides, "actorId" | "sessionId" | "runId"> & {
    readonly actorId: string;
    readonly sessionId: string;
    readonly runId: string;
  } {
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
    actorId: agentBase.actorId,
    sessionId: agentBase.sessionId || state.sessionId,
    runId: agentBase.runId || agentBase.traceId,
  } as unknown as Omit<DispatchContext, "actorId" | "sessionId" | "runId"> &
    Omit<TOverrides, "actorId" | "sessionId" | "runId"> & {
      readonly actorId: string;
      readonly sessionId: string;
      readonly runId: string;
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
