import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { EpochMs } from "../time.js";
import { ClosedBy } from "./schema.js";

/**
 * Lease lifecycle observations. Lossy projections of the durable facts —
 * subscribers must never write the ledger or authorize an action from them
 * (observe-only, the Wait/Conversation law). Every event inherits its
 * caller's trace; the store never mints one (D11).
 */

const EventBase = z.object({
  traceId: z.string().min(1),
  leaseId: z.string().min(1),
  conversationId: z.string().min(1),
  holderDelegationId: z.string().min(1),
  time: EpochMs,
});

export const LeaseEvents = {
  Issued: BusEvent.define(
    "lease.issued",
    EventBase.extend({
      contactId: z.string().min(1),
      maxOutbound: z.number().int().positive(),
      expiresAt: EpochMs,
    }),
    { visibility: "llm_reason" },
  ),
  Closed: BusEvent.define(
    "lease.closed",
    EventBase.extend({ closedBy: ClosedBy }),
    { visibility: "llm_reason" },
  ),
} as const;
