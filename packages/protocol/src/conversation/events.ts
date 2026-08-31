import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { EpochMs } from "../time.js";
import { ClosedBy, OpenedBy } from "./schema.js";

const EventBase = z.object({
  traceId: z.string().min(1),
  conversationId: z.string().min(1),
  contactId: z.string().min(1),
  endpointId: z.string().min(1),
  time: EpochMs,
});

/**
 * Conversation lifecycle audit trail. Event name strings are byte-frozen
 * wire vocabulary. `CapBreached` fires exactly once per window (first
 * inbound-cap crossing) — it is the owner wake the demote policy promises.
 */
export const ConversationEvents = {
  Opened: BusEvent.define(
    "conversation.opened",
    EventBase.extend({ openedBy: OpenedBy, expiresAt: EpochMs }),
    { visibility: "llm_reason" },
  ),
  Closed: BusEvent.define("conversation.closed", EventBase.extend({ closedBy: ClosedBy }), {
    visibility: "llm_reason",
  }),
  CapBreached: BusEvent.define("conversation.cap_breached", EventBase, {
    visibility: "llm_reason",
  }),
} as const;
