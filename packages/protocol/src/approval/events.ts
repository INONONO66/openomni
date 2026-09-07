import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { EpochMs } from "../time.js";
import { DecidedBy, State, Subject } from "./schema.js";

/**
 * Approval lifecycle observations. Lossy projections of the durable facts —
 * subscribers must never write the ledger or authorize an action from them
 * (observe-only, the Wait/Conversation law). Every event inherits its
 * caller's trace; the store never mints one (D11).
 */

const EventBase = z.object({
  traceId: z.string().min(1),
  approvalId: z.string().min(1),
  subject: Subject,
  time: EpochMs,
});

export const ApprovalEvents = {
  Requested: BusEvent.define("approval.requested", EventBase.extend({ deadline: EpochMs }), {
    visibility: "llm_reason",
  }),
  Decided: BusEvent.define(
    "approval.decided",
    EventBase.extend({ state: State.exclude(["pending"]), decidedBy: DecidedBy }),
    { visibility: "llm_reason" },
  ),
} as const;
