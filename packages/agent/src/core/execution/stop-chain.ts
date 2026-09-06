import { canonicalDigest } from "@openomni/protocol";

export interface StopObservation {
  readonly text: string;
  readonly toolCalls: number;
  readonly continueRequested?: boolean;
  readonly interrupted: boolean;
  readonly exhausted: boolean;
  readonly progress: boolean;
  readonly blocked: boolean;
  readonly openIntent: readonly string[];
  readonly alarmIds: readonly string[];
}
export interface StopState {
  readonly outputHash?: string;
  readonly repetition: number;
  readonly stall: number;
  readonly blocked: number;
  readonly continuation: number;
}
export type StopMetric = "exact_repeat" | "toolless_stall" | "blocked_recurrence" | "continuation";
export type StopVerdict =
  | { readonly kind: "interrupted"; readonly reason: "abort" }
  | { readonly kind: "result"; readonly reason: "completion" }
  | { readonly kind: "waiting"; readonly reason: "live_wait"; readonly alarmIds: readonly string[] }
  | { readonly kind: "continue"; readonly reason: "continue" }
  | { readonly kind: "error"; readonly reason: "budget" | StopMetric };

export class AgentStopError extends Error {
  readonly code = "agent_stop";
  constructor(readonly reason: Extract<StopVerdict, { kind: "error" }>["reason"]) {
    super(`agent stop: ${reason}`);
    this.name = "AgentStopError";
  }
}

export function stopState(): StopState {
  return { repetition: 0, stall: 0, blocked: 0, continuation: 0 };
}

/** Fixed precedence, including policy reads. Invocation is not effect/state progress. */
export async function judgeStop(
  previous: StopState,
  observation: StopObservation,
  limit: (metric: StopMetric) => Promise<number>,
  completion: () => Promise<boolean>,
): Promise<{ state: StopState; verdict: StopVerdict }> {
  const outputHash = canonicalDigest(observation.text);
  const state: StopState = {
    outputHash,
    repetition: observation.progress
      ? 0
      : outputHash === previous.outputHash
        ? previous.repetition + 1
        : 1,
    stall: observation.progress || observation.toolCalls > 0 ? 0 : previous.stall + 1,
    blocked: observation.blocked && !observation.progress ? previous.blocked + 1 : 0,
    continuation: previous.continuation + 1,
  };
  const done = (verdict: StopVerdict) => ({ state, verdict });
  if (observation.interrupted) return done({ kind: "interrupted", reason: "abort" });
  if (observation.exhausted) return done({ kind: "error", reason: "budget" });
  if (
    observation.text.length > 0 &&
    observation.toolCalls === 0 &&
    !observation.continueRequested
  ) {
    const permitted = await completion();
    if (permitted && observation.openIntent.length === 0 && !observation.blocked)
      return done({ kind: "result", reason: "completion" });
  }
  if (state.repetition >= (await limit("exact_repeat")))
    return done({ kind: "error", reason: "exact_repeat" });
  if (state.stall >= (await limit("toolless_stall")))
    return done({ kind: "error", reason: "toolless_stall" });
  if (state.blocked >= (await limit("blocked_recurrence")))
    return done({ kind: "error", reason: "blocked_recurrence" });
  if (observation.alarmIds.length > 0)
    return done({ kind: "waiting", reason: "live_wait", alarmIds: observation.alarmIds });
  if (state.continuation >= (await limit("continuation")))
    return done({ kind: "error", reason: "continuation" });
  return done({ kind: "continue", reason: "continue" });
}
