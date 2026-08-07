import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { RejectionCode } from "./fold.js";
import { OwnerKind, Status } from "./schema.js";

const EventBase = z.object({
  id: z.string().min(1),
  ownerKind: OwnerKind,
  ownerId: z.string().min(1),
  status: Status,
  time: z.number(),
});

export const Events = {
  Opened: BusEvent.define("wait.opened", EventBase, { visibility: "llm_reason" }),
  ReplyAttached: BusEvent.define(
    "wait.reply_attached",
    EventBase.extend({
      replyKey: z.string().min(1),
      responderId: z.string().min(1),
      responders: z.number().int().nonnegative(),
      threshold: z.number().int().min(1),
      followUp: z.boolean(),
    }),
    { visibility: "llm_reason" },
  ),
  Resolved: BusEvent.define("wait.resolved", EventBase.extend({ resolvedAt: z.number() }), {
    visibility: "llm_reason",
  }),
  Expired: BusEvent.define("wait.expired", EventBase.extend({ partial: z.boolean() }), {
    visibility: "llm_reason",
  }),
  Cancelled: BusEvent.define("wait.cancelled", EventBase.extend({ cancelledAt: z.number() }), {
    visibility: "llm_reason",
  }),
  ReplyRejected: BusEvent.define(
    "wait.reply_rejected",
    EventBase.extend({
      code: RejectionCode,
      replyKey: z.string().min(1),
    }),
    { visibility: "internal" },
  ),
} as const;
