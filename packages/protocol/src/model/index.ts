import { z } from "zod";

export namespace Model {
  export const Status = z.enum(["alpha", "beta", "deprecated", "active"]);
  export type Status = z.infer<typeof Status>;

  export const Ref = z.object({
    provider: z.string(),
    id: z.string(),
  });
  export type Ref = z.infer<typeof Ref>;
}
