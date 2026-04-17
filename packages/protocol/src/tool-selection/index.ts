import { z } from "zod";

export namespace ToolSelection {
  export const Category = z.enum(["filesystem", "execution", "delegation", "mcp", "custom"]);
  export type Category = z.infer<typeof Category>;

  export const Selection = z.object({
    all: z.boolean().optional(),
    categories: z.array(Category).optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  });
  export type Selection = z.infer<typeof Selection>;
}
