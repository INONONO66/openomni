import z from "zod";
import { NamedError, APIError } from "@openomni/protocol";

export { NamedError, APIError };

export const AuthError = NamedError.create(
  "AuthError",
  z.object({
    message: z.string(),
    provider: z.string(),
  }),
);

export const ProviderError = NamedError.create(
  "ProviderError",
  z.object({
    message: z.string(),
    provider: z.string(),
  }),
);

export const SessionError = NamedError.create(
  "SessionError",
  z.object({
    message: z.string(),
    sessionID: z.string().optional(),
  }),
);

export const StreamError = NamedError.create(
  "StreamError",
  z.object({
    message: z.string(),
  }),
);

export const RetryError = NamedError.create(
  "RetryError",
  z.object({
    message: z.string(),
    attempts: z.number(),
    lastError: z.string().optional(),
  }),
);

export const AbortedError = NamedError.create(
  "AbortedError",
  z.object({
    message: z.string(),
  }),
);

export const OutputLengthError = NamedError.create("OutputLengthError", z.object({}));
