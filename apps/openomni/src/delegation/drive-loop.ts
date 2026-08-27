/**
 * Goal-style drive policy for native worker runs (inline/process transports
 * only — a channel counterpart merely delivers and waits, it is never driven).
 * Pure: the transport driver feeds one observation per completed agent run
 * and acts on the decision. The policy lives here, never in the WorkItem
 * schema — the contract stays executor-agnostic.
 */

export const DRIVE_CONTINUATION_CAP = 8;
export const DRIVE_REPETITION_STREAK = 3;
export const DRIVE_TOOLLESS_STALL_STREAK = 3;
export const DRIVE_BLOCKED_RECURRENCE = 3;

export interface DriveObservation {
  /** Final text of the completed worker run. */
  readonly text: string;
  /** The agent loop's own ending for that run. */
  readonly finishReason: "stop" | "stalled" | "max-steps";
}

export interface DriveState {
  readonly runs: number;
  readonly lastText: string | undefined;
  readonly repetitionStreak: number;
  readonly stallStreak: number;
  readonly blockedStreak: number;
}

type DriveStopReason = "continuation_cap" | "repetition" | "toolless_stall" | "blocked";

export type DriveDecision =
  | { readonly action: "done" }
  | { readonly action: "continue"; readonly prompt: string; readonly state: DriveState }
  | { readonly action: "stop"; readonly reason: DriveStopReason };

export function initialDriveState(): DriveState {
  return { runs: 0, lastText: undefined, repetitionStreak: 0, stallStreak: 0, blockedStreak: 0 };
}

const BLOCKED_CLAIM = /^\s*BLOCKED\b/i;

const CONTINUE_PROMPT =
  "The assignment is not finished. Continue working toward the acceptance criteria with your tools, produce evidence, then give your final answer.";

const BLOCKED_PROMPT =
  "You reported BLOCKED. Re-verify the blocker with your tools; if it is not absolute, continue the assignment. Repeat the BLOCKED report only if the same blocker truly recurs.";

export function decideDrive(state: DriveState, observation: DriveObservation): DriveDecision {
  const runs = state.runs + 1;
  const blocked = BLOCKED_CLAIM.test(observation.text);
  const repetitionStreak = state.lastText === observation.text ? state.repetitionStreak + 1 : 1;
  const blockedStreak = blocked ? state.blockedStreak + 1 : 0;
  // A recurring blocker is the truthful stop reason even when its wording
  // repeats verbatim, so the blocked gate outranks the repetition gate.
  if (blockedStreak >= DRIVE_BLOCKED_RECURRENCE) return { action: "stop", reason: "blocked" };
  if (repetitionStreak >= DRIVE_REPETITION_STREAK) return { action: "stop", reason: "repetition" };
  if (observation.finishReason === "stop" && !blocked) return { action: "done" };

  // "max-steps" is live work: the step budget ended mid-flight, which is
  // progress — it resets the stall and blocked streaks.
  const stallStreak = observation.finishReason === "stalled" ? state.stallStreak + 1 : 0;
  if (stallStreak >= DRIVE_TOOLLESS_STALL_STREAK) return { action: "stop", reason: "toolless_stall" };
  if (runs >= DRIVE_CONTINUATION_CAP) return { action: "stop", reason: "continuation_cap" };

  return {
    action: "continue",
    prompt: blocked ? BLOCKED_PROMPT : CONTINUE_PROMPT,
    state: { runs, lastText: observation.text, repetitionStreak, stallStreak, blockedStreak },
  };
}
