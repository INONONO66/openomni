import { BusEvent } from "@openomni/session";
import { z } from "zod";
import { MessageDenialCode, MessageOperation } from "./schema.js";

const EventBase = z.object({
  messageId: z.string().min(1),
  senderId: z.string().min(1),
  targetActorId: z.string().min(1),
  time: z.number(),
});

/**
 * Deterministic messaging audit trail (#215): every send lands exactly one of
 * these. Fire-and-forget leaves ONLY the `Sent` event (no Wait row); denials
 * leave ONLY the `Denied` event (no delivery, no Wait, no allocation).
 */
export const Events = {
  Sent: BusEvent.define(
    "messaging.sent",
    EventBase.extend({
      operation: MessageOperation,
      grantId: z.string().min(1),
      endpointId: z.string().min(1),
      waitId: z.string().min(1).optional(),
    }),
    { visibility: "llm_reason" },
  ),
  Denied: BusEvent.define("messaging.denied", EventBase.extend({ code: MessageDenialCode }), {
    visibility: "internal",
  }),
} as const;
