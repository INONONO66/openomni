import { z } from "zod";

export namespace BusEvent {
  export interface Descriptor<T> {
    name: string;
    schema: z.ZodSchema<T>;
  }

  export function define<T>(
    name: string,
    schema: z.ZodSchema<T>,
  ): Descriptor<T> {
    return { name, schema };
  }
}
