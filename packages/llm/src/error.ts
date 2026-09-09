import z from "zod";
import { NamedError } from "@openomni/protocol";

export { NamedError };

/**
 * #500 C3: APIError's home — moved here from protocol (its callers were
 * llm-only: retry classification and provider-error coercion below). The
 * previous alias re-export of the protocol definition is gone with the move.
 */
export const APIError = NamedError.create(
  "APIError",
  z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    aborted: z.boolean().optional(),
    contextOverflow: z.boolean().optional(),
  }),
);

export const ProviderError = NamedError.create(
  "ProviderError",
  z.object({
    message: z.string(),
    provider: z.string(),
  }),
);

const ErrorFacts = z.object({
  aborted: z.boolean().optional().catch(undefined),
  contextOverflow: z.boolean().optional().catch(undefined),
});
const WrappedFacts = z.object({ data: ErrorFacts });

/** Named errors carry facts under data; SDK errors carry them directly. */
export function errorFacts(error: unknown): z.infer<typeof ErrorFacts> {
  const wrapped = WrappedFacts.safeParse(error);
  return wrapped.success ? wrapped.data.data : ErrorFacts.catch({}).parse(error);
}

const ResponseHeaders = z
  .record(z.string(), z.string().optional().catch(undefined))
  .catch({})
  .transform((headers) => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) result[key.toLowerCase()] = value;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  });
const ProviderFailure = ErrorFacts.extend({
  message: z.string(),
  isRetryable: z.boolean(),
  statusCode: z.number().optional().catch(undefined),
  responseHeaders: ResponseHeaders,
  responseBody: z.string().optional().catch(undefined),
});

/** Decode SDK error fields before retry classification, preserving the native cause. */
export function coerceApiError(error: unknown): InstanceType<typeof APIError> | undefined {
  if (APIError.isInstance(error)) return error;
  const candidate = ProviderFailure.safeParse(error);
  return candidate.success ? new APIError(candidate.data, { cause: error }) : undefined;
}
