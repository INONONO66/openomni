/**
 * The run's shape, as a guard rather than a driver (D4).
 *
 * The loop still decides what happens next; this refuses an order that cannot
 * happen. Two properties earn it:
 *
 *   - the terminal tags have no outgoing edges, so a run cannot end twice, and
 *     `assertSettled` turns "ended without ending" from a convention every
 *     `return` has to remember into something the run cannot leave without;
 *   - the table is the injection-point map. Each non-terminal tag names the
 *     policy point dispatched while the run is in it, so the order the points
 *     fire in is stated once, here, instead of being implied by the order of
 *     statements in the loop.
 *
 * The tag is a plain string by design: it is the part of a run's position that
 * survives serialization, which is what a resume would need.
 */
export type RunTag =
  | "opening"
  | "pre_run"
  | "turn_start"
  | "awaiting_model"
  | "settling"
  | "retrying"
  | "completed"
  | "failed";

/** The policy point dispatched while the run holds each tag. */
export const RUN_POINT: Readonly<Partial<Record<RunTag, string>>> = Object.freeze({
  pre_run: "run.lifecycle.pre",
  turn_start: "run.turn.pre",
  awaiting_model: "connection.llm.pre",
  settling: "run.turn.post",
  retrying: "run.error.error",
});

const EDGES: Readonly<Record<RunTag, readonly RunTag[]>> = Object.freeze({
  opening: ["pre_run", "completed", "failed"],
  pre_run: ["turn_start", "completed", "failed"],
  turn_start: ["awaiting_model", "retrying", "completed", "failed"],
  awaiting_model: ["settling", "retrying", "completed", "failed"],
  settling: ["turn_start", "retrying", "completed", "failed"],
  retrying: ["turn_start", "completed", "failed"],
  completed: [],
  failed: [],
});

export interface RunMachine {
  /** Where the run is. Serializable by construction. */
  readonly tag: () => RunTag;
  /** Moves the run, refusing an edge the table does not have. */
  readonly to: (next: RunTag) => void;
  /** Throws unless the run reached a terminal. */
  readonly assertSettled: () => void;
}

export function runMachine(): RunMachine {
  let current: RunTag = "opening";
  return {
    tag: () => current,
    to: (next) => {
      if (!EDGES[current].includes(next)) {
        throw new Error(`run cannot move from ${current} to ${next}`);
      }
      current = next;
    },
    assertSettled: () => {
      if (EDGES[current].length > 0) {
        throw new Error(`run left ${current} without reaching a terminal`);
      }
    },
  };
}
