import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const ScopedBase = BusEvent.Metadata.extend({
  eventId: z.string().min(1),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  componentId: z.string().min(1),
  componentGeneration: z.number().int().nonnegative(),
  time: z.number(),
});

export namespace Component {
  export namespace Events {
    export const Active = BusEvent.define("component.active", ScopedBase, {
      visibility: "internal",
    });

    export const Failed = BusEvent.define(
      "component.failed",
      ScopedBase.extend({ error: z.string() }),
      { visibility: "internal" },
    );

    export const Disposed = BusEvent.define(
      "component.disposed",
      ScopedBase.extend({
        outcome: z.enum(["completed", "failed", "replaced", "shutdown"]),
      }),
      { visibility: "internal" },
    );
  }
}
