import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  time: z.number(),
});

export namespace IngressEvent {
  export const Received = BusEvent.define(
    "ingress.received",
    Base.extend({
      surface: z.string(),
      mode: z.enum(["plan", "direct"]),
      payloadLength: z.number(),
    }),
  );

  export const ModeDetected = BusEvent.define(
    "ingress.mode.detected",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct"]),
    }),
  );

  export const SessionResolved = BusEvent.define(
    "ingress.session.resolved",
    Base.extend({
      sessionId: z.string(),
      isNew: z.boolean(),
    }),
  );

  export const Completed = BusEvent.define(
    "ingress.completed",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct"]),
      durationMs: z.number(),
    }),
  );
}
