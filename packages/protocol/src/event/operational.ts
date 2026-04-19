import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  time: z.number(),
});

export namespace Operational {
  export const BootstrapCompleted = BusEvent.define(
    "operational.bootstrap.completed",
    Base.extend({
      mode: z.enum(["local", "coordinator"]),
      channelCount: z.number(),
    }),
  );

  export const ShutdownInitiated = BusEvent.define(
    "operational.shutdown.initiated",
    Base.extend({
      reason: z.string(),
    }),
  );

  export const RecoveryStarted = BusEvent.define("operational.recovery.started", Base);

  export const RecoveryCompleted = BusEvent.define(
    "operational.recovery.completed",
    Base.extend({
      sessionsRecovered: z.number(),
      durationMs: z.number(),
    }),
  );
}
