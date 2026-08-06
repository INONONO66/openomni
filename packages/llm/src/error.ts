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
