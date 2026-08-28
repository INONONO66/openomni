import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { RejectionCode } from "./fold.js";
import { OwnerKind, Status } from "./schema.js";
import { EpochMs } from "../time.js";

const EventBase = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  ownerKind: OwnerKind,
  ownerId: z.string().min(1),
  status: Status,
  time: EpochMs,
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
  Resolved: BusEvent.define("wait.resolved", EventBase.extend({ resolvedAt: EpochMs }), {
    visibility: "llm_reason",
  }),
  Expired: BusEvent.define("wait.expired", EventBase.extend({ partial: z.boolean() }), {
    visibility: "llm_reason",
  }),
  Cancelled: BusEvent.define("wait.cancelled", EventBase.extend({ cancelledAt: EpochMs }), {
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
  /**
   * Audit trail for the synchronous in-process resident.ask path (#215 owner
   * decision 2): the ask resolves inside one dispatch, so it records audit
   * events only and never opens a durable Wait row.
   */
  SyncAsk: BusEvent.define(
    "wait.sync_ask",
    z.object({
      dispatchId: z.string().min(1),
      traceId: z.string().min(1),
      sessionId: z.string().min(1),
      phase: z.enum(["opened", "answered", "failed"]),
      time: EpochMs,
    }),
    { visibility: "internal" },
  ),
} as const;
