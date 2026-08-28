import { z } from "zod";
import * as Schema from "./schema.js";

/**
 * Pure deterministic engagement state machine (gateway-design §5, #709).
 * Time (`at`) and every judgment verdict (`termCrossed`, `ownerApproved`)
 * are INPUTS — the fold never reads the clock, never evaluates money or
 * criteria, and never inspects dialogue. It is the FSM of authority and
 * resumption, NOT of conversation content (design non-goal §10).
 *
 * Legal edges (the §5 diagram; `aborted` is reachable from every non-terminal
 * state, `expired` only through {@link expire}):
 *
 *   planning              → awaiting_external | deliberating
 *   awaiting_external     → deliberating
 *   deliberating          → awaiting_external | awaiting_user_approval | acting
 *   awaiting_user_approval→ acting (ownerApproved required) | deliberating
 *   acting                → done
 *
 * Overrides, in rule order (each earlier rule wins):
 *   1. terminal record        -> rejected engagement_terminal
 *   2. deadline passed        -> rejected deadline_passed (call expire)
 *   3. termCrossed reported   -> FORCED to awaiting_user_approval (any
 *                                non-abort request; §5 "crossing a term
 *                                forces awaiting_user_approval")
 *   4. edge legality          -> rejected illegal_transition
 *   5. acting from approval   -> rejected approval_required unless the
 *                                caller asserts ownerApproved (the gate
 *                                verdict is computed above protocol)
 */

const TransitionInputBase = z
  .object({
    /** Requested target state. `expired` is never requestable; `planning` is entry-only. */
    to: Schema.State,
    at: z.number(),
    /** The declared move, recorded verbatim on the transition event. */
    reason: z.string().min(1),
    /**
     * Reported fact: a delegation term was crossed. The machine records the
     * report and forces `awaiting_user_approval`; whether the term WAS
     * crossed is the reporter's (LLM's) judgment, never evaluated here.
     */
    termCrossed: z.boolean().optional(),
    /**
     * Owner-approval fact for the awaiting_user_approval → acting edge. The
     * caller (the transition tool) derives it from the triggering delivery's
     * perimeter trust tier; the fold only demands the assertion.
     */
    ownerApproved: z.boolean().optional(),
    /** Replaces the open-wait set; REQUIRED (non-empty) when entering awaiting_external. */
    waitIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const TransitionInput = TransitionInputBase.superRefine((input, ctx) => {
  if (input.to === "expired") {
    ctx.addIssue({
      code: "custom",
      message: "expired is never a requested target — expiry is the machine's own edge",
      path: ["to"],
    });
  }
  if (input.to === "planning") {
    ctx.addIssue({
      code: "custom",
      message: "planning is the entry state — no edge returns to it",
      path: ["to"],
    });
  }
});
export type TransitionInput = z.infer<typeof TransitionInput>;

export const RejectionCode = z.enum([
  "engagement_terminal",
  "illegal_transition",
  "approval_required",
  "waits_required",
  "deadline_passed",
  "not_expired",
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

export type Outcome =
  | { kind: "transitioned"; record: Schema.Record; from: Schema.State; to: Schema.State }
  | {
      /**
       * A reported term crossing overrode the requested target: the record
       * moved to awaiting_user_approval regardless of `requested`. Still a
       * successful transition — the forcing is the §5 safety rule, not an
       * error.
       */
      kind: "forced_approval";
      record: Schema.Record;
      from: Schema.State;
      requested: Schema.State;
    }
  | { kind: "expired"; record: Schema.Record; from: Schema.State }
  | { kind: "rejected"; code: RejectionCode; record: Schema.Record; at: number };

const TERMINAL: ReadonlySet<Schema.State> = new Set(["done", "aborted", "expired"]);

const EDGES: Readonly<Partial<Record<Schema.State, readonly Schema.State[]>>> = {
  planning: ["awaiting_external", "deliberating"],
  awaiting_external: ["deliberating"],
  deliberating: ["awaiting_external", "awaiting_user_approval", "acting"],
  awaiting_user_approval: ["acting", "deliberating"],
  acting: ["done"],
};

function edgeAllowed(from: Schema.State, to: Schema.State): boolean {
  if (to === "aborted") return !TERMINAL.has(from);
  return (EDGES[from] ?? []).includes(to);
}

function apply(record: Schema.Record, input: TransitionInput, to: Schema.State): Schema.Record {
  const openWaitIds = TERMINAL.has(to) ? [] : (input.waitIds ?? record.openWaitIds);
  return {
    ...record,
    state: to,
    openWaitIds,
    revision: record.revision + 1,
    updatedAt: input.at,
  };
}

export function transition(record: Schema.Record, input: TransitionInput): Outcome {
  if (TERMINAL.has(record.state)) {
    return { kind: "rejected", code: "engagement_terminal", record, at: input.at };
  }
  if (record.expiresAt !== undefined && input.at > record.expiresAt && input.to !== "aborted") {
    return { kind: "rejected", code: "deadline_passed", record, at: input.at };
  }
  if (input.termCrossed === true && input.to !== "aborted") {
    if (record.state === "awaiting_user_approval") {
      // Already at the stop the crossing forces — re-forcing is a no-edge.
      return { kind: "rejected", code: "illegal_transition", record, at: input.at };
    }
    return {
      kind: "forced_approval",
      record: apply(record, input, "awaiting_user_approval"),
      from: record.state,
      requested: input.to,
    };
  }
  if (!edgeAllowed(record.state, input.to)) {
    return { kind: "rejected", code: "illegal_transition", record, at: input.at };
  }
  if (
    input.to === "acting" &&
    record.state === "awaiting_user_approval" &&
    input.ownerApproved !== true
  ) {
    return { kind: "rejected", code: "approval_required", record, at: input.at };
  }
  if (
    input.to === "awaiting_external" &&
    (input.waitIds === undefined || input.waitIds.length === 0)
  ) {
    return { kind: "rejected", code: "waits_required", record, at: input.at };
  }
  return {
    kind: "transitioned",
    record: apply(record, input, input.to),
    from: record.state,
    to: input.to,
  };
}

/** Deadline expiry — the machine's own edge, legal from every non-terminal state. */
export function expire(record: Schema.Record, input: { at: number }): Outcome {
  if (TERMINAL.has(record.state)) {
    return { kind: "rejected", code: "engagement_terminal", record, at: input.at };
  }
  if (record.expiresAt === undefined || input.at <= record.expiresAt) {
    return { kind: "rejected", code: "not_expired", record, at: input.at };
  }
  return {
    kind: "expired",
    record: {
      ...record,
      state: "expired",
      openWaitIds: [],
      revision: record.revision + 1,
      updatedAt: input.at,
    },
    from: record.state,
  };
}
