import type { BusEvent } from "@openomni/protocol";
import { Actor, Operational } from "@openomni/protocol";
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

export function effectiveBudgetThresholds(budget?: Actor.Profile.BudgetThresholdInput): {
  reassuranceThreshold: number;
  warningThreshold: number;
} {
  return {
    reassuranceThreshold:
      budget?.reassuranceThreshold ?? Actor.Profile.DEFAULT_REASSURANCE_THRESHOLD,
    warningThreshold: budget?.warningThreshold ?? Actor.Profile.DEFAULT_WARNING_THRESHOLD,
  };
}

export type BudgetStatus = "ok" | "reassurance" | "warning" | "exceeded";

// Enforcement and narration share the same ceilings.
const BUDGET_DEFAULTS = {
  maxTurns: 24,
  maxToolCalls: 40,
  maxWallTimeMs: 5 * 60 * 1000,
  maxToolRuntimeMs: 2 * 60 * 1000,
} as const;

type ExceededLimit = "wall time" | "turns" | "tool calls" | "tool wall time";

interface BudgetEvaluation {
  readonly status: BudgetStatus;
  readonly elapsedMs: number;
  readonly maxRatio: number;
  readonly exceededLimit?: ExceededLimit;
}

/**
 * The tool-call pool the budget actually enforces (-1 = unlimited). Exported
 * because the turn's step cap subtracts from this exact pool — a cap computed
 * against any other number starves or overshoots the real enforcement.
 */
export function effectiveMaxToolCalls(budget?: AgentBudget): number {
  return budget?.maxToolCalls ?? BUDGET_DEFAULTS.maxToolCalls;
}

/**
 * Sole evaluator of the 4-state budget verdict and the facts telemetry
 * needs (reads the clock, mutates nothing, emits nothing) — see
 * {@link publishBudgetTelemetry}, the single production consumer.
 */
export function evaluateBudget(state: BudgetState, budget?: AgentBudget): BudgetEvaluation {
  const { warningThreshold: warningRatio, reassuranceThreshold: reassuranceRatio } =
    effectiveBudgetThresholds(budget);
  const elapsedMs = Date.now() - state.startTime;
  const limits: readonly [ExceededLimit, number, number][] = [
    ["wall time", elapsedMs, budget?.maxWallTimeMs ?? BUDGET_DEFAULTS.maxWallTimeMs],
    ["turns", state.turns, budget?.maxTurns ?? BUDGET_DEFAULTS.maxTurns],
    ["tool calls", state.toolCalls, effectiveMaxToolCalls(budget)],
    [
      "tool wall time",
      state.toolRuntimeMs,
      budget?.maxToolRuntimeMs ?? BUDGET_DEFAULTS.maxToolRuntimeMs,
    ],
  ];
  const ratios: number[] = [];
  for (const [exceededLimit, consumed, maximum] of limits) {
    if (maximum === -1) continue;
    if (consumed >= maximum) {
      return { status: "exceeded", elapsedMs, maxRatio: 1, exceededLimit };
    }
    ratios.push(consumed / maximum);
  }

  if (ratios.length === 0) return { status: "ok", elapsedMs, maxRatio: 0 };

  const maxRatio = Math.max(...ratios);
  if (maxRatio >= warningRatio) return { status: "warning", elapsedMs, maxRatio };
  if (maxRatio >= reassuranceRatio) return { status: "reassurance", elapsedMs, maxRatio };
  return { status: "ok", elapsedMs, maxRatio };
}

/**
 * Command: emit the budget observability telemetry once and return the status
 * for the caller to act on. Invoked from the per-turn lifecycle check so the
 * event fires exactly once per turn, never once per policy that reads it.
 */
export function publishBudgetTelemetry(
  state: BudgetState,
  /** The run being reported on. Structural: this needs a trace and a session. */
  run: { readonly traceId: string; readonly sessionId: string },
  events: BusEvent.Sink,
  budget?: AgentBudget,
): BudgetStatus {
  const evaluation = evaluateBudget(state, budget);

  if (evaluation.status === "exceeded") {
    events.publish(Operational.Events.Warn, {
      traceId: run.traceId,
      sessionId: run.sessionId,
      time: Date.now(),
      component: "agent.budget",
      msg: `budget exceeded: ${evaluation.exceededLimit}`,
      context: {
        type: "exceeded",
        turns: state.turns,
        toolCalls: state.toolCalls,
        wallTimeMs: evaluation.elapsedMs,
        ...(evaluation.exceededLimit === "tool wall time"
          ? { toolRuntimeMs: state.toolRuntimeMs }
          : {}),
      },
    });
    return evaluation.status;
  }
  if (evaluation.status === "warning") {
    events.publish(Operational.Events.Warn, {
      traceId: run.traceId,
      sessionId: run.sessionId,
      time: Date.now(),
      component: "agent.budget",
      msg: "budget threshold warning",
      context: {
        type: "warning",
        remaining: describeBudgetRemaining(state, budget),
        ratio: evaluation.maxRatio.toFixed(2),
      },
    });
    return evaluation.status;
  }
  if (evaluation.status === "reassurance") {
    events.publish(Operational.Events.Info, {
      traceId: run.traceId,
      sessionId: run.sessionId,
      time: Date.now(),
      component: "agent.budget",
      msg: "budget threshold reassurance",
      context: {
        type: "reassurance",
        remaining: describeBudgetRemaining(state, budget),
        ratio: evaluation.maxRatio.toFixed(2),
      },
    });
  }
  return evaluation.status;
}

export function describeBudgetRemaining(state: BudgetState, budget?: AgentBudget): string {
  const parts: string[] = [];

  const maxTurns = budget?.maxTurns ?? BUDGET_DEFAULTS.maxTurns;
  if (maxTurns === -1) {
    parts.push("unlimited turns remaining");
  } else {
    const remaining = maxTurns - state.turns;
    parts.push(`${remaining} turn${remaining !== 1 ? "s" : ""} remaining`);
  }

  const maxToolCalls = effectiveMaxToolCalls(budget);
  if (maxToolCalls !== -1) {
    const remaining = maxToolCalls - state.toolCalls;
    parts.push(`${remaining} tool call${remaining !== 1 ? "s" : ""} remaining`);
  }

  const maxWallTimeMs = budget?.maxWallTimeMs ?? BUDGET_DEFAULTS.maxWallTimeMs;
  if (maxWallTimeMs !== -1) {
    const elapsed = Date.now() - state.startTime;
    const remaining = Math.max(0, maxWallTimeMs - elapsed);
    parts.push(`${Math.round(remaining / 1000)}s wall time remaining`);
  }

  const maxToolRuntimeMs = budget?.maxToolRuntimeMs ?? BUDGET_DEFAULTS.maxToolRuntimeMs;
  if (maxToolRuntimeMs !== -1) {
    const remaining = Math.max(0, maxToolRuntimeMs - state.toolRuntimeMs);
    parts.push(`${Math.round(remaining / 1000)}s tool wall time remaining`);
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
