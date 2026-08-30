import { z } from "zod";

export namespace BusEvent {
  export const Visibility = z.enum(["internal", "llm_reason", "user_audit", "ephemeral"]);
  export type Visibility = z.infer<typeof Visibility>;

  export interface Options {
    readonly visibility?: Visibility;
  }

  export interface Descriptor<T> {
    readonly name: string;
    readonly schema: z.ZodSchema<T>;
    readonly visibility?: Visibility;
  }

  export function define<T>(
    name: string,
    schema: z.ZodSchema<T>,
    options: Options = {},
  ): Descriptor<T> {
    return options.visibility === undefined
      ? { name, schema }
      : { name, schema, visibility: options.visibility };
  }

  /**
   * Event-publishing port for ring-2 drivers (coordinator, llm). Drivers
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
