import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { EpochMs } from "../time.js";

const Base = z.object({
  traceId: z.string(),
  time: EpochMs,
});

const LogBase = Base.extend({
  sessionId: z.string().optional(),
  component: z.string(),
  msg: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export namespace Operational {
  /** Fields a producer supplies for an operational log envelope. */
  export interface LogFields {
    readonly traceId: string;
    readonly component: string;
    readonly msg: string;
    readonly sessionId?: string;
    readonly context?: Readonly<Record<string, unknown>>;
    readonly error?: string;
  }

  /** Attaches the producer's timestamp to log fields (no validation here — the bus event schema validates on publish). */
  export function envelope<Fields extends LogFields>(
    fields: Fields,
    time: number,
  ): Fields & { readonly time: number } {
    return { ...fields, time };
  }

  export namespace Events {
    export const Debug = BusEvent.define("operational.debug", LogBase, { visibility: "ephemeral" });

    export const Info = BusEvent.define("operational.info", LogBase, { visibility: "ephemeral" });

    export const Warn = BusEvent.define("operational.warn", LogBase, { visibility: "internal" });

    // biome-ignore lint/suspicious/noShadowRestrictedNames: expose Operational.Events.Error to match the namespaced event API
    export const Error = BusEvent.define(
      "operational.error",
      LogBase.extend({ error: z.string().optional() }),
      { visibility: "llm_reason" },
    );
  }
}
