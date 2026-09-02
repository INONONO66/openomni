import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { EpochMs } from "../time.js";
import * as Schema from "./schema.js";

const TriggerEventBase = z.object({
  traceId: z.string().min(1),
  time: EpochMs,
  triggerId: z.string().min(1),
});
const TriggerRevision = z.object({
  triggerRevision: z.number().int().positive().max(Schema.Constants.MAX_COUNTER),
});
const FireEventBase = TriggerEventBase.extend({
  fireId: z.string().min(1),
  fireRevision: z.number().int().positive().max(Schema.Constants.MAX_COUNTER),
});

export const Events = {
  Created: BusEvent.define(
    "trigger.created",
    TriggerEventBase.extend({
      ownerSessionId: z.string().min(1),
      kind: z.enum(Schema.Kinds),
      triggerRevision: TriggerRevision.shape.triggerRevision,
    }).strict(),
    { visibility: "user_audit" },
  ),
  Paused: BusEvent.define(
    "trigger.paused",
    TriggerEventBase.extend({
      pauseReason: Schema.PauseReason,
      triggerRevision: TriggerRevision.shape.triggerRevision,
    }).strict(),
    { visibility: "user_audit" },
  ),
  Rearmed: BusEvent.define(
    "trigger.rearmed",
    TriggerEventBase.extend({
      triggerRevision: TriggerRevision.shape.triggerRevision,
      nextFireAt: EpochMs.optional(),
    }).strict(),
    { visibility: "user_audit" },
  ),
  Ended: BusEvent.define(
    "trigger.ended",
    TriggerEventBase.extend({
      endReason: Schema.EndReason,
      triggerRevision: TriggerRevision.shape.triggerRevision,
    }).strict(),
    { visibility: "user_audit" },
  ),
  FireRecorded: BusEvent.define(
    "trigger.fire.recorded",
    FireEventBase.extend({
      cause: Schema.FireCause,
      triggerRevision: TriggerRevision.shape.triggerRevision,
    }).strict(),
    { visibility: "internal" },
  ),
  FireDelivered: BusEvent.define(
    "trigger.fire.delivered",
    FireEventBase.extend({ sessionId: z.string().min(1) }).strict(),
    { visibility: "internal" },
  ),
  FireAcked: BusEvent.define(
    "trigger.fire.acked",
    FireEventBase.extend({
      sessionId: z.string().min(1),
      messageId: z.string().min(1),
    }).strict(),
    { visibility: "internal" },
  ),
} as const;
