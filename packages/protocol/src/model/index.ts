import { z } from "zod";

export namespace Model {
  export const Ref = z.object({
    provider: z.string(),
    id: z.string(),
  });
  export type Ref = z.infer<typeof Ref>;
}
