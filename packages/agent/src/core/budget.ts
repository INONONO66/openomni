import { AgentProfile, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentBudget } from "./types";

export interface BudgetState {
  startTime: number;
  turns: number;
  toolCalls: number;
  toolRuntimeMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export function createBudgetState(): BudgetState {
  return {
    startTime: Date.now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

export function effectiveBudgetThresholds(budget?: AgentProfile.BudgetThresholdInput): {
  reassuranceThreshold: number;
  warningThreshold: number;
} {
  return {
    reassuranceThreshold:
      budget?.reassuranceThreshold ?? AgentProfile.DEFAULT_REASSURANCE_THRESHOLD,
    warningThreshold: budget?.warningThreshold ?? AgentProfile.DEFAULT_WARNING_THRESHOLD,
  };
}

export function checkBudget(
  state: BudgetState,
  budget?: AgentBudget,
): "ok" | "reassurance" | "warning" | "exceeded" {
  const maxWallTimeMs = budget?.maxWallTimeMs ?? 5 * 60 * 1000;
  const maxTurns = budget?.maxTurns ?? 24;
  const maxToolCalls = budget?.maxToolCalls ?? 40;
  const maxToolRuntimeMs = budget?.maxToolRuntimeMs ?? 2 * 60 * 1000;
  const { warningThreshold: warningRatio, reassuranceThreshold: reassuranceRatio } =
    effectiveBudgetThresholds(budget);

  const elapsed = Date.now() - state.startTime;

  if (maxWallTimeMs !== -1 && elapsed >= maxWallTimeMs) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "agent.budget",
      msg: "budget exceeded: wall time",
      context: {
        type: "exceeded",
        turns: state.turns,
        toolCalls: state.toolCalls,
        wallTimeMs: elapsed,
      },
    });
    return "exceeded";
  }
  if (maxTurns !== -1 && state.turns >= maxTurns) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "agent.budget",
      msg: "budget exceeded: turns",
      context: {
        type: "exceeded",
        turns: state.turns,
        toolCalls: state.toolCalls,
        wallTimeMs: elapsed,
      },
    });
    return "exceeded";
  }
  if (maxToolCalls !== -1 && state.toolCalls >= maxToolCalls) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "agent.budget",
      msg: "budget exceeded: tool calls",
      context: {
        type: "exceeded",
        turns: state.turns,
        toolCalls: state.toolCalls,
        wallTimeMs: elapsed,
      },
    });
    return "exceeded";
  }
  if (maxToolRuntimeMs !== -1 && state.toolRuntimeMs >= maxToolRuntimeMs) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "agent.budget",
      msg: "budget exceeded: tool runtime",
      context: {
        type: "exceeded",
        turns: state.turns,
        toolCalls: state.toolCalls,
        wallTimeMs: elapsed,
        toolRuntimeMs: state.toolRuntimeMs,
      },
    });
    return "exceeded";
  }

  const ratios: number[] = [];
  if (maxWallTimeMs !== -1) ratios.push(elapsed / maxWallTimeMs);
  if (maxTurns !== -1) ratios.push(state.turns / maxTurns);
  if (maxToolCalls !== -1) ratios.push(state.toolCalls / maxToolCalls);
  if (maxToolRuntimeMs !== -1) ratios.push(state.toolRuntimeMs / maxToolRuntimeMs);

  if (ratios.length === 0) return "ok";

  const maxRatio = Math.max(...ratios);

  if (maxRatio >= warningRatio) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "agent.budget",
      msg: "budget threshold warning",
      context: {
        type: "warning",
        remaining: describeBudgetRemaining(state, budget),
        ratio: maxRatio.toFixed(2),
      },
    });
    return "warning";
  }
  if (maxRatio >= reassuranceRatio) {
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "agent.budget",
      msg: "budget threshold reassurance",
      context: {
        type: "reassurance",
        remaining: describeBudgetRemaining(state, budget),
        ratio: maxRatio.toFixed(2),
      },
    });
    return "reassurance";
  }
  return "ok";
}

export function describeBudgetRemaining(state: BudgetState, budget?: AgentBudget): string {
  const parts: string[] = [];

  const maxTurns = budget?.maxTurns ?? 24;
  if (maxTurns === -1) {
    parts.push("unlimited turns remaining");
  } else {
    const remaining = maxTurns - state.turns;
    parts.push(`${remaining} turn${remaining !== 1 ? "s" : ""} remaining`);
  }

  const maxToolCalls = budget?.maxToolCalls ?? 40;
  if (maxToolCalls !== -1) {
    const remaining = maxToolCalls - state.toolCalls;
    parts.push(`${remaining} tool call${remaining !== 1 ? "s" : ""} remaining`);
  }

  const maxWallTimeMs = budget?.maxWallTimeMs ?? 5 * 60 * 1000;
  if (maxWallTimeMs !== -1) {
    const elapsed = Date.now() - state.startTime;
    const remaining = Math.max(0, maxWallTimeMs - elapsed);
    parts.push(`${Math.round(remaining / 1000)}s wall time remaining`);
  }

  const maxToolRuntimeMs = budget?.maxToolRuntimeMs ?? 2 * 60 * 1000;
  if (maxToolRuntimeMs !== -1) {
    const remaining = Math.max(0, maxToolRuntimeMs - state.toolRuntimeMs);
    parts.push(`${Math.round(remaining / 1000)}s tool runtime remaining`);
  }

  return parts.join(", ");
}

export function recordTurn(state: BudgetState): BudgetState {
  return { ...state, turns: state.turns + 1 };
}

export function recordToolCall(state: BudgetState, durationMs: number): BudgetState {
  return {
    ...state,
    toolCalls: state.toolCalls + 1,
    toolRuntimeMs: state.toolRuntimeMs + durationMs,
  };
}

export function recordTokenUsage(
  state: BudgetState,
  inputTokens: number,
  outputTokens: number,
): BudgetState {
  return {
    ...state,
    totalInputTokens: state.totalInputTokens + inputTokens,
    totalOutputTokens: state.totalOutputTokens + outputTokens,
  };
}
