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
}
