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
      target: z.string().optional(),
      payloadLength: z.number(),
    }),
  );

  export const ModeDetected = BusEvent.define(
    "ingress.mode.detected",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct"]),
      target: z.string().optional(),
    }),
  );

  export const SessionResolved = BusEvent.define(
    "ingress.session.resolved",
    Base.extend({
      sessionId: z.string(),
      isNew: z.boolean(),
      target: z.enum(["main", "new-worker", "worker"]).optional(),
    }),
  );

  export const Completed = BusEvent.define(
    "ingress.completed",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct"]),
      target: z.string().optional(),
      durationMs: z.number(),
    }),
  );

  export const Failed = BusEvent.define(
    "ingress.failed",
    Base.extend({
      sessionId: z.string(),
      mode: z.enum(["plan", "direct"]),
      target: z.string().optional(),
      durationMs: z.number(),
      error: z.string(),
    }),
  );
}
