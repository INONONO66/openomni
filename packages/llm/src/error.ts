import z from "zod";
import { NamedError, APIError } from "@openomni/protocol";

export { NamedError, APIError };

export const ProviderError = NamedError.create(
  "ProviderError",
  z.object({
    message: z.string(),
    provider: z.string(),
  }),
);
