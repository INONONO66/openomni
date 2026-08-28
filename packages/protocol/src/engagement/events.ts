import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { RejectionCode } from "./fold.js";
import { State } from "./schema.js";
import { EpochMs } from "../time.js";

const EventBase = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  ownerSessionId: z.string().min(1),
  time: EpochMs,
});

/**
 * Engagement observation descriptors (#709). Transitions are `user_audit`:
 * the engagement machine is the delegation safety mechanism — what the agent
 * promised, whom it awaits, when the user must approve — so every state
 * change is Owner-visible by construction.
 */
export const Events = {
  Opened: BusEvent.define(
    "engagement.opened",
    EventBase.extend({
      title: z.string().min(1),
      state: State,
    }),
    { visibility: "user_audit" },
  ),
  Transitioned: BusEvent.define(
    "engagement.transitioned",
    EventBase.extend({
      from: State,
      to: State,
      reason: z.string().min(1),
      /** True when a reported term crossing overrode the requested target (§5 forcing rule). */
      forced: z.boolean(),
    }),
    { visibility: "user_audit" },
  ),
  TransitionRejected: BusEvent.define(
    "engagement.transition_rejected",
    EventBase.extend({
      code: RejectionCode,
      requested: State,
      state: State,
    }),
    { visibility: "internal" },
  ),
} as const;
