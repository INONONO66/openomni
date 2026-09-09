import { z } from "zod";

export const shellCommandSchema = z.union([
  z.enum(["new-tab", "close-tab", "reopen-tab", "next-tab", "previous-tab", "back", "forward"]),
  z.templateLiteral([
    "select-tab-",
    z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
    ]),
  ]),
]);

export const gatewayEndpointSchema = z
  .object({
    url: z.string(),
    token: z.string().optional(),
  })
  .optional();
