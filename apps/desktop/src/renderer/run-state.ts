import type { StateTier, StatusShape } from "@openomni/ui";
import type { RunState } from "./mock/console";

/**
 * The single mapping from this product's run states onto the design system's
 * shape and tone vocabularies.
 *
 * It lives in the app rather than in `@openomni/ui` because `RunState` is the
 * product's domain union: a design system that knew the word `interrupted`
 * would own a vocabulary whose source it cannot see. The system offers shapes
 * and tiers; this file decides which state is shaped like a ring.
 *
 * It is ONE file because the sidebar and the delegation tree render the same
 * states, and two tables would let them drift — which they already had. The
 * navigator was drawing `interrupted` as settled while the worker tree drew it
 * as attention, so one surface said a stopped worker was still asking for
 * something and the other said it was closed. A reader comparing the two
 * columns would have had no way to tell which was lying.
 */

/**
 * Each shape is argued from the state's meaning, not assigned arbitrarily:
 *   running     — a filled dot, breathing. The only live claim.
 *   waiting     — hollow. Something is expected and has not arrived.
 *   done        — filled and quiet. Closed, complete, no longer asking.
 *   interrupted — struck through. Stopped, not finished.
 */
export const RUN_STATE_SHAPE: Record<RunState, StatusShape> = {
  running: "pulse",
  waiting: "ring",
  done: "filled",
  interrupted: "slashed",
};

/**
 * Tone follows the accent budget, which is stricter than the shape vocabulary:
 * exactly ONE state may take the chroma, and it is the one happening right now.
 *
 * `waiting` is `attention` because it is a claim about the OWNER'S queue —
 * something is blocked on them, so it must not recede. `interrupted` is
 * `settled`: it is a stopped run, and while a reader may want to restart it,
 * the run itself is not asking for anything. Its slash carries the difference
 * from `done`, so tone does not have to.
 */
export const RUN_STATE_TIER: Record<RunState, StateTier> = {
  running: "live",
  waiting: "attention",
  done: "settled",
  interrupted: "settled",
};
