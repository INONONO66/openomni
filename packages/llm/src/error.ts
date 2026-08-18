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
  }),
);

export const ProviderError = NamedError.create(
  "ProviderError",
  z.object({
    message: z.string(),
    provider: z.string(),
  }),
);

/**
 * Coerce an AI SDK provider error (AI_APICallError and shape-compatible
 * wrappers) into the protocol APIError so retry classification can read
 * statusCode/isRetryable/responseHeaders. AI SDK errors carry these fields
 * directly on the error object, not under `.data`, and their `name` never
 * matches APIError.isInstance — without this coercion no real provider
 * error is ever classified as retryable.
 */
export function coerceApiError(error: unknown): InstanceType<typeof APIError> | undefined {
  if (APIError.isInstance(error)) return error;
  if (typeof error !== "object" || error === null) return undefined;

  const candidate = error as {
    message?: unknown;
    isRetryable?: unknown;
    statusCode?: unknown;
    responseHeaders?: unknown;
    responseBody?: unknown;
  };
  if (typeof candidate.message !== "string" || typeof candidate.isRetryable !== "boolean") {
    return undefined;
  }

  const responseHeaders: Record<string, string> = {};
  if (typeof candidate.responseHeaders === "object" && candidate.responseHeaders !== null) {
    for (const [key, value] of Object.entries(candidate.responseHeaders)) {
      if (typeof value === "string") responseHeaders[key.toLowerCase()] = value;
    }
  }

  return new APIError(
    {
      message: candidate.message,
      isRetryable: candidate.isRetryable,
      ...(typeof candidate.statusCode === "number" && { statusCode: candidate.statusCode }),
      ...(Object.keys(responseHeaders).length > 0 && { responseHeaders }),
      ...(typeof candidate.responseBody === "string" && {
        responseBody: candidate.responseBody,
      }),
    },
    { cause: error },
  );
}
