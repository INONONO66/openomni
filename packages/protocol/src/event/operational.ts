import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  time: z.number(),
});

const LogBase = Base.extend({
  sessionId: z.string().optional(),
  component: z.string(),
  msg: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export namespace Operational {
  export const Debug = BusEvent.define("operational.debug", LogBase, { visibility: "ephemeral" });

  export const Info = BusEvent.define("operational.info", LogBase, { visibility: "ephemeral" });

  export const Warn = BusEvent.define("operational.warn", LogBase, { visibility: "internal" });

  // biome-ignore lint/suspicious/noShadowRestrictedNames: expose Operational.Error to match the namespaced event API
  export const Error = BusEvent.define(
    "operational.error",
    LogBase.extend({ error: z.string().optional() }),
    { visibility: "llm_reason" },
  );

  export const BootstrapCompleted = BusEvent.define(
    "operational.bootstrap.completed",
    Base.extend({
      mode: z.enum(["local", "coordinator"]),
      channelCount: z.number(),
    }),
    { visibility: "internal" },
  );

  export const ShutdownInitiated = BusEvent.define(
    "operational.shutdown.initiated",
    Base.extend({
      reason: z.string(),
    }),
    { visibility: "internal" },
  );

  export const RecoveryStarted = BusEvent.define("operational.recovery.started", Base, {
    visibility: "ephemeral",
  });

  export const RecoveryCompleted = BusEvent.define(
    "operational.recovery.completed",
    Base.extend({
      sessionsRecovered: z.number(),
      durationMs: z.number(),
    }),
    { visibility: "internal" },
  );
}
