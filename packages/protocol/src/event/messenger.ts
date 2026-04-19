import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  envelopeId: z.string(),
  time: z.number(),
});

export namespace MessengerEvent {
  export const EnvelopeCreated = BusEvent.define(
    "messenger.envelope.created",
    Base.extend({
      fromAgentId: z.string(),
      toAgentId: z.string(),
      correlationId: z.string().nullable(),
    }),
  );

  export const Delivered = BusEvent.define(
    "messenger.delivered",
    Base.extend({
      fromAgentId: z.string(),
      toAgentId: z.string(),
    }),
  );

  export const DeliveryFailed = BusEvent.define(
    "messenger.delivery.failed",
    Base.extend({
      reason: z.string(),
    }),
  );
}
