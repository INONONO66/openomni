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
}
