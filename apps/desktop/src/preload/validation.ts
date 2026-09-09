import { z } from "zod";

export const gatewayEndpointSchema = z.object({
  url: z.string(),
  token: z.string().optional(),
}).optional();
