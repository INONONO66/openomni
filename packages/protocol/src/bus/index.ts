import { z } from "zod";

export namespace BusEvent {
  export const Visibility = z.enum(["internal", "llm_reason", "user_audit", "ephemeral"]);
  export type Visibility = z.infer<typeof Visibility>;

  export interface Options {
    readonly visibility?: Visibility;
  }

  export interface Descriptor<T> {
    readonly name: string;
    readonly schema: z.ZodType<T, T>;
    readonly visibility?: Visibility;
  }

  export function define<T>(
    name: string,
    schema: z.ZodType<T, T>,
    options: Options = {},
  ): Descriptor<T> {
    return options.visibility === undefined
      ? { name, schema }
      : { name, schema, visibility: options.visibility };
  }

  /**
   * Event-publishing port for driver-band packages (agent, llm). Drivers
   * receive a Sink instead of importing the ledger's Bus directly; the
   * composition root binds it to Bus.publish, tests bind a collector.
   * This is the one binding P2 swaps when Ledger.append (fail-closed)
   * splits from lossy Bus.publish (#462 §2, #455).
   */
  export interface Sink {
    publish<T>(event: Descriptor<T>, data: T): void;
  }

  /**
   * Collector-owned correlation carried alongside every scoped observation.
   * Domain schemas remain free to describe only their payload; persistence
   * validates and preserves this allowlisted metadata independently.
   */
  export const Metadata = z.object({
    eventId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
    parentSpanId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    callId: z.string().min(1).optional(),
    role: z.enum(["resident", "worker"]).optional(),
    actorId: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    componentGeneration: z.number().int().nonnegative().optional(),
    pluginName: z.string().min(1).optional(),
    pluginVersion: z.string().min(1).optional(),
    configRevision: z.number().int().nonnegative().optional(),
    time: z.number().optional(),
  });
  export type Metadata = z.infer<typeof Metadata>;
}

/**
 * Observation is a lossy copy of an already-decided fact. Implementations may
 * fan out or drop publications, but scoped identity is authoritative: scope
 * fields are applied after payload fields so an emitter cannot impersonate a
 * different session, turn, call, or agent.
 */
export interface ObservationSink extends BusEvent.Sink {
  scope(identity: Readonly<BusEvent.Metadata>): ObservationSink;
  subscribe?<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void;
}
